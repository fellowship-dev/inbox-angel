import { XMLParser } from 'fast-xml-parser';
import {
  AggregateReport, AuthResults, DkimAuthResult, Disposition,
  Identifiers, InvalidAggregateReport, IpInfo, PolicyEvaluated,
  PolicyOverrideReason, ReportRecord, SpfAuthResult,
} from './types';
import { getIpInfo, getCachedIpInfo, cacheIpInfo } from './ip-info';

// Regexes ported from parsedmarc
const XML_HEADER_REGEX = /<\?xml[^>]+\?>/i;
const XML_SCHEMA_REGEX = /<\/?xs:schema.*>/gim; // strips opening + closing xs:schema tag lines

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
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
}

async function parseReportRecord(
  record: Record<string, unknown>,
  offline = false,
  db?: D1Database,
  budget?: { newIps: number },
): Promise<ReportRecord> {
  const row = record['row'] as Record<string, unknown>;
  if (!row?.['source_ip']) throw new Error('Source IP address is empty');

  const ip = str(row['source_ip']);
  let source: IpInfo;
  if (offline) {
    source = BARE_IP_INFO(ip);
  } else {
    const cached = db ? await getCachedIpInfo(db, ip) : null;
    if (cached) {
      source = cached;
    } else if (budget && budget.newIps <= 0) {
      source = BARE_IP_INFO(ip);
    } else {
      if (budget) budget.newIps--;
      source = await getIpInfo(ip);
      if (db) await cacheIpInfo(db, source).catch(() => {}); // best-effort
    }
  }

  const count = parseInt(str(row['count']), 10) || 1;

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
  let envelopeFrom = strOrNull(rawIdent['envelope_from']);
  const envelopeTo = strOrNull(rawIdent['envelope_to']);

  // auth_results
  const rawAuth = (record['auth_results'] as Record<string, unknown>) ?? {};
  const authResults: AuthResults = { dkim: [], spf: [] };

  const rawDkim = Array.isArray(rawAuth['dkim']) ? rawAuth['dkim'] : rawAuth['dkim'] ? [rawAuth['dkim']] : [];
  for (const d of rawDkim as Record<string, unknown>[]) {
    if (d['domain']) {
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
      xml = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(xml);
    }

    // Strip invalid XML header variants and schema tags (parsedmarc does same)
    xml = xml.replace(XML_HEADER_REGEX, '<?xml version="1.0"?>');
    xml = xml.replace(XML_SCHEMA_REGEX, '');

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

    // Normalize: strip subdomain + lowercase if it looks like a domain (matches publicsuffixlist behaviour)
    if (!orgName.includes(' ')) {
      const parts = orgName.replace(/\.$/, '').split('.');
      if (parts.length > 2) orgName = parts.slice(-2).join('.');
      orgName = orgName.toLowerCase();
    }

    const reportId = str(meta['report_id'])
      .replace('<', '').replace('>', '').split('@')[0];

    const dateRange = meta['date_range'] as Record<string, unknown>;
    const beginTs = parseTimestamp(dateRange['begin'] as string | number);
    const endTs = parseTimestamp(dateRange['end'] as string | number);

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
      throw new InvalidAggregateReport(`Report has ${recordList.length} records; the limit is ${limits.maxRecords}`);
    }
    const budget = limits.maxNewIps === undefined ? undefined : { newIps: limits.maxNewIps };

    const records: ReportRecord[] = [];
    for (const r of recordList as Record<string, unknown>[]) {
      try {
        records.push(await parseReportRecord(r, offline, db, budget));
      } catch (e) {
        // parsedmarc warns and skips bad records — match that behaviour
        console.warn(`Skipping unparseable record: ${e}`);
      }
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
    if (e instanceof InvalidAggregateReport) throw e;
    throw new InvalidAggregateReport(`Unexpected error: ${e}`);
  }
}
