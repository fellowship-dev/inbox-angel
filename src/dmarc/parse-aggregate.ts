import { XMLParser } from 'fast-xml-parser';
import {
  AggregateReport, AuthResults, DkimAuthResult, Disposition,
  Identifiers, InvalidAggregateReport, IpInfo, PolicyEvaluated,
  PolicyOverrideReason, ReportRecord, ReportRejected, ParseStop, SpfAuthResult,
} from './types';
import { enrichIps } from './ip-info';

// Regexes ported from parsedmarc
const XML_HEADER_REGEX = /<\?xml[^>]+\?>/i;
const XML_SCHEMA_REGEX = /<\/?xs:schema.*>/gim; // strips opening + closing xs:schema tag lines

/**
 * Entity handling is stated, not inherited from the library's defaults. DOCTYPE and ENTITY declarations are refused before parsing
 * (a DMARC report has none), so the only entities left are the five standard escapes, which the parser still has to decode:
 * `processEntities: false` would leave `&amp;` undecoded, so the object form keeps them and bounds everything else. A library
 * upgrade cannot widen these (see test/dmarc/parse-aggregate.test.ts, "entities").
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  processEntities: {
    enabled: true,
    maxEntityCount: 5,
    maxEntitySize: 16,
    maxExpansionDepth: 1,
    maxTotalExpansions: 1_000_000,
    maxExpandedLength: 64 * 1024 * 1024,
  },
  // Force these paths to always be arrays even when only one element exists
  isArray: (name, _jpath, _isLeaf, isAttribute) => {
    if (isAttribute) return false;
    return ['record', 'reason', 'dkim', 'spf'].includes(name);
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
}

// parsedmarc strips fractional seconds before parseInt — match exactly
function parseTimestamp(raw: string | number): number {
  return parseInt(String(raw).split('.')[0], 10);
}

function normalizeDisposition(raw: string | null | undefined): Disposition {
  if (!raw) return 'none';
  const lower = raw.trim().toLowerCase();
  // parsedmarc coerces "pass" → "none" (some senders send this erroneously)
  if (lower === 'pass') return 'none';
  if (lower === 'quarantine') return 'quarantine';
  if (lower === 'reject') return 'reject';
  return 'none';
}

function str(val: unknown): string {
  return val == null ? '' : String(val);
}

function strOrNull(val: unknown): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

// ── _parse_report_record ──────────────────────────────────────────────────

const BARE_IP_INFO = (ip: string): IpInfo => ({
  ip, reverse_dns: null, base_domain: null, country_code: null,
  country_name: null, subdivision: null, city: null, org: null, asn: null,
});

/** Limits on a single report's work; unset = unlimited (self-host). */
export interface ParseLimits {
  /** Refuse (before any lookup) a report with more records than this. */
  maxRecords?: number;
  /** Uncached source IPs to enrich per report; further records are stored with bare IP info. */
  maxNewIps?: number;
  /** The clock, unix seconds (tests). */
  now?: number;
  /**
   * Called once the report's header is validated and before any per-record work (IP enrichment): a place to resolve the domain, skip a
   * duplicate and apply record-count caps. It ends processing by throwing ParseStop.
   */
  gate?: (info: { report_id: string; policy_domain: string; org_name: string; report_email: string | null; record_count: number }) => Promise<void | { enrich?: boolean; maxNewIps?: number }>;
}

/** Longest value kept for the fields we store (the report id and org name are shorter, domains are DNS names). */
const MAX_FIELD = 512;
const MAX_IDENTITY = 256;
const MAX_DOMAIN = 253;
const MAX_IP = 45;
/** Messages one record may claim (a 32-bit count; a larger one is nonsense and would distort every sum). */
const MAX_COUNT = 2_147_483_647;
/** A report covers a day, sometimes a week. Anything longer than a month is not an aggregate report. */
const MAX_SPAN_SECONDS = 31 * 86400;
/** DMARC aggregate reporting began in 2012; earlier dates are nonsense. */
const EARLIEST_BEGIN = Date.UTC(2012, 0, 1) / 1000;
/** A report cannot end more than a day from now (clocks differ, time zones). */
const FUTURE_SLACK_SECONDS = 2 * 86400;
/** A report is a few levels deep (feedback > record > auth_results > dkim > domain). Far deeper is an attack on the parser, not a report. */
const MAX_XML_DEPTH = 20;
/** Elements in a report: ~14 per record plus the header. The cap follows the records cap (20 per record), so it scales with an operator's limit. */
const ELEMENTS_PER_RECORD = 20;

/** Refuse pathological nesting or element counts before the parser builds a tree (parsedmarc advisories: depth and node bombs). Linear, no tree. */
export function checkXmlShape(xml: string, maxElements: number): void {
  // XML 1.0 forbids these; a NUL in a stored value breaks downstream databases and exporters (parsedmarc GHSA-fxr7-7h9q-v949).
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml)) throw new ReportRejected('xml_invalid', 'Report contains control characters');
  const text = xml.includes('<!--') ? xml.replace(/<!--[\s\S]*?-->/g, '') : xml;
  const re = /<(\/?)([A-Za-z_][^\s>/]*)[^>]*?(\/?)>/g;
  let depth = 0;
  let elements = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1]) { depth = Math.max(0, depth - 1); continue; }
    if (++elements > maxElements) throw new ReportRejected('xml_invalid', `Report has more than ${maxElements} elements`);
    if (!m[3]) { if (++depth > MAX_XML_DEPTH) throw new ReportRejected('xml_invalid', `Report is nested deeper than ${MAX_XML_DEPTH} levels`); }
  }
}

function tooLong(what: string, value: string, max: number): void {
  if (value.length > max) throw new ReportRejected('field_too_long', `${what} is longer than ${max} characters`);
}

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]{2,45})$/i;

function parseReportRecord(record: Record<string, unknown>): ReportRecord {
  const row = record['row'] as Record<string, unknown>;
  if (!row?.['source_ip']) throw new Error('Source IP address is empty');

  const ip = str(row['source_ip']).trim();
  if (ip.length > MAX_IP) throw new ReportRejected('field_too_long', `source_ip is longer than ${MAX_IP} characters`);
  if (!IP_RE.test(ip)) throw new Error(`Source IP address is not an IP address`);
  // IP enrichment happens once per report, for all records together (enrichIps), not here: one D1 query per record would
  // exhaust the per-invocation query budget on a large report.
  const source: IpInfo = BARE_IP_INFO(ip);

  const count = Math.min(Math.max(parseInt(str(row['count']), 10) || 1, 1), MAX_COUNT);

  // policy_evaluated
  const pe = (row['policy_evaluated'] as Record<string, unknown>) ?? {};
  const spfAligned = str(pe['spf']).toLowerCase() === 'pass';
  const dkimAligned = str(pe['dkim']).toLowerCase() === 'pass';

  const rawReasons = (pe['reason'] as unknown[]) ?? [];
  const reasons: PolicyOverrideReason[] = (Array.isArray(rawReasons) ? rawReasons : [rawReasons])
    .map((r: unknown) => {
      const rr = r as Record<string, unknown>;
      return { type: str(rr['type']), comment: strOrNull(rr['comment']) };
    });

  const policyEvaluated: PolicyEvaluated = {
    disposition: normalizeDisposition(strOrNull(pe['disposition'])),
    dkim: spfAligned || dkimAligned ? (dkimAligned ? 'pass' : 'fail') : 'fail',
    spf: spfAligned ? 'pass' : 'fail',
    policy_override_reasons: reasons,
  };

  // identifiers — parsedmarc supports both "identities" and "identifiers" key
  const rawIdent = (record['identifiers'] ?? record['identities']) as Record<string, unknown> ?? {};
  const headerFrom = str(rawIdent['header_from']).toLowerCase();
  tooLong('header_from', headerFrom, MAX_DOMAIN);
  let envelopeFrom = strOrNull(rawIdent['envelope_from']);
  const envelopeTo = strOrNull(rawIdent['envelope_to']);

  // auth_results
  const rawAuth = (record['auth_results'] as Record<string, unknown>) ?? {};
  const authResults: AuthResults = { dkim: [], spf: [] };

  const rawDkim = Array.isArray(rawAuth['dkim']) ? rawAuth['dkim'] : rawAuth['dkim'] ? [rawAuth['dkim']] : [];
  for (const d of rawDkim as Record<string, unknown>[]) {
    if (d['domain']) {
      tooLong('dkim domain', str(d['domain']), MAX_DOMAIN);
      tooLong('dkim selector', str(d['selector'] ?? ''), MAX_FIELD);
      authResults.dkim.push({
        domain: str(d['domain']),
        selector: strOrNull(d['selector']) ?? 'none',
        result: (strOrNull(d['result']) ?? 'none') as DkimAuthResult['result'],
      });
    }
  }

  const rawSpf = Array.isArray(rawAuth['spf']) ? rawAuth['spf'] : rawAuth['spf'] ? [rawAuth['spf']] : [];
  for (const s of rawSpf as Record<string, unknown>[]) {
    if (s['domain']) {
      tooLong('spf domain', str(s['domain']), MAX_DOMAIN);
      authResults.spf.push({
        domain: str(s['domain']),
        scope: strOrNull(s['scope']) ?? 'mfrom',
        result: (strOrNull(s['result']) ?? 'none') as SpfAuthResult['result'],
      });
    }
  }

  // Infer envelope_from from last SPF result if missing (parsedmarc behaviour)
  if (!envelopeFrom && authResults.spf.length > 0) {
    const lastSpf = authResults.spf[authResults.spf.length - 1];
    envelopeFrom = lastSpf.domain.toLowerCase() || null;
  }

  const identifiers: Identifiers = {
    header_from: headerFrom,
    envelope_from: envelopeFrom,
    envelope_to: envelopeTo,
  };

  return {
    source,
    count,
    alignment: { spf: spfAligned, dkim: dkimAligned, dmarc: spfAligned || dkimAligned },
    policy_evaluated: policyEvaluated,
    identifiers,
    auth_results: authResults,
  };
}

// ── parse_aggregate_report_xml ────────────────────────────────────────────

export async function parseAggregateReportXml(
  xml: string | Uint8Array,
  offline = false,
  db?: D1Database,
  limits: ParseLimits = {},
): Promise<AggregateReport> {
  try {
    if (xml instanceof Uint8Array) {
      try {
        xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(xml);
      } catch {
        throw new ReportRejected('xml_invalid', 'Report is not valid UTF-8');
      }
    }

    // Strip invalid XML header variants and schema tags (parsedmarc does same)
    xml = xml.replace(XML_HEADER_REGEX, '<?xml version="1.0"?>');
    xml = xml.replace(XML_SCHEMA_REGEX, '');

    if (/<!(?:DOCTYPE|ENTITY)/i.test(xml)) throw new ReportRejected('xml_invalid', 'DOCTYPE and entity declarations are not allowed in a DMARC report');

    checkXmlShape(xml, limits.maxRecords !== undefined ? limits.maxRecords * ELEMENTS_PER_RECORD + 1000 : 500_000);

    let parsed: Record<string, unknown>;
    try {
      parsed = parser.parse(xml) as Record<string, unknown>;
    } catch (e) {
      throw new InvalidAggregateReport(`Invalid XML: ${e}`);
    }

    const feedback = parsed['feedback'] as Record<string, unknown>;
    if (!feedback) throw new InvalidAggregateReport('Missing <feedback> root element');

    // xml_schema
    const schema = strOrNull(feedback['version']) ?? 'draft';

    // report_metadata
    const meta = feedback['report_metadata'] as Record<string, unknown>;
    if (!meta) throw new InvalidAggregateReport('Missing field: report_metadata');

    let orgName = strOrNull(meta['org_name']);
    if (!orgName && meta['email']) {
      orgName = str(meta['email']).split('@').pop() ?? null;
    }
    if (!orgName) throw new InvalidAggregateReport('Missing field: org_name');

    tooLong('org_name', orgName, MAX_IDENTITY);

    // Normalize: strip subdomain + lowercase if it looks like a domain (matches publicsuffixlist behaviour)
    if (!orgName.includes(' ')) {
      const parts = orgName.replace(/\.$/, '').split('.');
      if (parts.length > 2) orgName = parts.slice(-2).join('.');
      orgName = orgName.toLowerCase();
    }

    const reportId = str(meta['report_id'])
      .replace('<', '').replace('>', '').split('@')[0];

    tooLong('report_id', reportId, MAX_IDENTITY);
    tooLong('email', str(meta['email']), MAX_FIELD);

    const dateRange = meta['date_range'] as Record<string, unknown> | undefined;
    const beginTs = parseTimestamp(dateRange?.['begin'] as string | number);
    const endTs = parseTimestamp(dateRange?.['end'] as string | number);
    const now = limits.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(beginTs) || !Number.isFinite(endTs)) throw new ReportRejected('date_range_invalid', 'Report has no usable date range');
    if (endTs < beginTs) throw new ReportRejected('date_range_invalid', 'Report period ends before it begins');
    if (endTs - beginTs > MAX_SPAN_SECONDS) throw new ReportRejected('date_range_invalid', 'Report period is longer than 31 days');
    if (beginTs < EARLIEST_BEGIN) throw new ReportRejected('date_range_invalid', 'Report period begins before 2012');
    if (endTs > now + FUTURE_SLACK_SECONDS) throw new ReportRejected('date_range_invalid', 'Report period ends in the future');

    const metaErrors: string[] = [];
    if (meta['error']) {
      const errs = Array.isArray(meta['error']) ? meta['error'] : [meta['error']];
      metaErrors.push(...errs.map(String));
    }

    // policy_published — may come as a list (take first)
    let pp = feedback['policy_published'];
    if (Array.isArray(pp)) pp = pp[0];
    const pol = pp as Record<string, unknown>;
    if (!pol) throw new InvalidAggregateReport('Missing field: policy_published');

    tooLong('policy_published domain', str(pol['domain']), MAX_DOMAIN);
    const policyPublished = {
      domain: str(pol['domain']),
      adkim: (strOrNull(pol['adkim']) ?? 'r') as 'r' | 's',
      aspf: (strOrNull(pol['aspf']) ?? 'r') as 'r' | 's',
      p: normalizeDisposition(strOrNull(pol['p'])) as Disposition,
      sp: normalizeDisposition(strOrNull(pol['sp'] ?? pol['p'])) as Disposition,
      pct: parseInt(str(pol['pct'] ?? '100'), 10) || 100,
      fo: strOrNull(pol['fo']) ?? '0',
    };

    // records — always an array (isArray config above ensures this)
    const rawRecords = feedback['record'];
    if (!rawRecords) throw new InvalidAggregateReport('Missing field: record');
    const recordList = Array.isArray(rawRecords) ? rawRecords : [rawRecords];

    if (limits.maxRecords !== undefined && recordList.length > limits.maxRecords) {
      throw new ReportRejected('too_many_records', `Report has ${recordList.length} records; the limit is ${limits.maxRecords}`);
    }

    const plan = await limits.gate?.({ report_id: reportId, policy_domain: policyPublished.domain, org_name: orgName, report_email: strOrNull(meta['email']), record_count: recordList.length });

    const records: ReportRecord[] = [];
    for (const r of recordList as Record<string, unknown>[]) {
      try {
        records.push(parseReportRecord(r));
      } catch (e) {
        if (e instanceof ReportRejected) throw e;
        // parsedmarc warns and skips bad records — match that behaviour
        console.warn(`Skipping unparseable record: ${e}`);
      }
    }

    if (!offline && plan?.enrich !== false) {
      const weight = new Map<string, number>();
      for (const r of records) weight.set(r.source.ip, (weight.get(r.source.ip) ?? 0) + r.count);
      const info = await enrichIps(db, [...weight.keys()], plan?.maxNewIps ?? limits.maxNewIps, (ip) => weight.get(ip) ?? 0);
      for (const r of records) r.source = info.get(r.source.ip) ?? r.source;
    }

    return {
      xml_schema: schema,
      report_metadata: {
        org_name: orgName,
        org_email: strOrNull(meta['email']) ?? '',
        org_extra_contact_info: strOrNull(meta['extra_contact_info']),
        report_id: reportId,
        begin_date: unixToIso(beginTs),
        end_date: unixToIso(endTs),
        errors: metaErrors,
      },
      policy_published: policyPublished,
      records,
    };
  } catch (e) {
    if (e instanceof InvalidAggregateReport || e instanceof ParseStop) throw e;
    throw new InvalidAggregateReport(`Unexpected error: ${e}`);
  }
}
