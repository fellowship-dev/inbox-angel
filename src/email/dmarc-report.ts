// Handles inbound DMARC aggregate report emails.
// Flow: extract bytes → parse the report header → (gate: domain, duplicate, caps) → enrich IPs → store atomically in D1.
//
// Routing is by report content (policy_published.domain), not by the recipient address in self-host: a fixed
// rua=mailto:rua@reports.yourdomain.com serves every domain. Hosted intake routes by token (src/hosted/intake.ts).
//
// What the sender is told, and why (reason codes: src/hosted/reasons.ts):
//   refused    setReject: a permanent 5xx in the SMTP session (no backscatter). Used when retrying cannot help.
//   deferred   the handler throws: used ONLY when D1 failed while storing, which is transient. Cloudflare does not document what
//              an uncaught throw tells the sender, so it is never the only record: the failure is also counted for the owner
//              (intake_failures). After INTAKE_MAX_STORAGE_RETRIES_PER_DAY failures for a domain the message is refused for good.
//   accepted   stored, or already stored (a duplicate).
// A report is never accepted and dropped.

import type { TenantContext } from '../tenancy/context';
import { extractAttachmentBytes, MimeExtractError } from './mime-extract';
import { resolveDomain } from './resolve-domain';
import { parseDmarcEmail, ParseEmailError } from '../dmarc/parse-email';
import { ParseStop } from '../dmarc/types';
import { coversDomain, type TokenDomain } from '../hosted/scope';
import { intakeLimits } from '../hosted/config';
import { getMode } from '../tenancy/mode';
import { reportCounting } from '../dmarc/counting';
import { normalizeDomain } from '@ready-set-mail/dns-checks';
import { storeReport } from '../dmarc/store-report';
import { carrierFromHeaders, decideTier, reporterInfo, type Carrier, type ReporterTier, type TierDecision } from '../dmarc/reporter-auth';
import type { ReporterInfo } from '../dmarc/store-report';
import { globalQueries } from '@ready-set-mail/db';
import { readAuthHeaders, type AuthHeaders } from './sender-proof';
import { logReporterCandidate, senderText } from '../hosted/intake-log';
import { rawXmlRetentionDays } from '../lifecycle/config';
import { rawTooLarge, REASONS, type Outcome, type ReasonCode } from '../hosted/reasons';

export interface ReportOptions {
  /** Cap on the decompressed report (default MAX_REPORT_BYTES, which also bounds zip/gzip bombs in self-host). */
  maxBytes?: number;
  /** Refuse reports with more records than this, before any per-record work. */
  maxRecords?: number;
  /** Uncached source IPs enriched per report. */
  maxNewIps?: number;
  /**
   * Hosted intake: the domain the recipient's token belongs to. The report's policy_published domain must be that
   * domain or a subdomain of it; it is filed under the token's domain, or under the subdomain's own row when the same
   * workspace has it as a verified domain. Anything else is rejected.
   */
  token?: TokenDomain;
  /** The topmost results headers, when the caller has already read them (hosted intake does, to pick the allowance). */
  authHeaders?: AuthHeaders;
  /**
   * Called with the report's record count and tier once its domain is known and it is not a duplicate: return a reason to refuse it (a cap
   * on stored records: counted and uncounted reports have separate budgets), else null. Nothing was enriched or stored yet.
   */
  admit?: (recordCount: number, tier: ReporterTier) => ReasonCode | null;
  /** The clock, unix seconds (tests). */
  now?: number;
  /** The carrier, when the caller has already classified it (hosted intake does, to pick caps and the decompression limit). Absent: decided here. */
  carrier?: Carrier;
  /**
   * A registry reporter over a cap is ACCEPTED, not stored, counted for the owner (reason over_cap_accepted_dropped), and never answered with a 5xx:
   * whether Google or Microsoft stop sending after a 5xx could not be verified. Set for carriers of class 'registry'.
   */
  dropOverCap?: boolean;
  /** Caps on the report's tier, after the tier is known (records stored, unauthenticated records): return a reason to refuse. */
  admitTier?: (tier: ReporterTier) => ReasonCode | null;
  /**
   * Hosted fixed address: the policy domain the intake routed this report by (read before the full parse). The parsed policy_published
   * domain must be exactly this, or the report is refused and nothing is stored.
   */
  expectedDomain?: string;
}

export interface ReportResult {
  failure_count: number;
  outcome: Outcome;
  reason: ReasonCode;
  /** Records in the report (null: it was not parsed far enough to know). */
  records: number | null;
  /** The AUTHENTICATED sending domain (never the report's own claim), null when the sender was not authenticated. */
  reporter: string | null;
  /** What the intake decided about the sender (null: not decided, refused before). */
  tier: ReporterTier | null;
  /** The reporter identity: registry id, else the authenticated organisation, else '~unauth'. */
  identity?: string | null;
  /** The passing DKIM organisation and the From organisation of the carrier (reporter data). */
  dkimOrg?: string | null;
  fromOrg?: string | null;
  /** Did report_metadata/email match the registry entry (null: no entry matched the carrier). */
  emailMatched?: boolean | null;
  /** What happened to the report id: new, duplicate, or superseded an uncounted report. */
  dedup?: 'new' | 'duplicate' | 'superseded' | null;
}

const today = () => new Date().toISOString().slice(0, 10);
/** A short hash naming one message (domain, reporter identity, report id) for the per-message failure counter; no report content is kept. */
async function messageKey(domainId: number, identity: string, reportId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domainId}|${identity}|${reportId}`));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** The caps on stored records: when one of them stops a COUNTED report the owner is told, by reporter and first drop time. */
const STORAGE_CAPS: ReadonlySet<string> = new Set(['cap_address_records', 'cap_workspace_storage', 'cap_instance_storage']);

export async function handleDmarcReport(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  opts: ReportOptions = {},
): Promise<ReportResult> {
  const result = (outcome: Outcome, reason: ReasonCode, extra: Partial<ReportResult> = {}): ReportResult =>
    ({ failure_count: 0, outcome, reason, records: null, reporter: null, tier: null, ...extra });
  const refuse = (reason: ReasonCode, text: string = REASONS[reason], extra: Partial<ReportResult> = {}): ReportResult => {
    message.setReject(text);
    return result('refused', reason, extra);
  };

  const limits = intakeLimits(tenant.env);

  // 0. The message itself: reading its attachment holds several copies at once, so a very large one is refused first
  if (message.rawSize > limits.maxRawBytes) return refuse('raw_too_large', rawTooLarge(limits.maxRawBytes));

  // 1. Extract attachment bytes from raw MIME stream (the headers are read from a second branch of it)
  let bytes: Uint8Array;
  let authHeaders = opts.authHeaders;
  try {
    let raw = message.raw;
    if (!authHeaders) {
      const [forHeaders, rest] = message.raw.tee();
      raw = rest;
      authHeaders = await readAuthHeaders(forHeaders);
    }
    bytes = await extractAttachmentBytes(raw);
  } catch (err) {
    console.error('dmarc-report: mime extraction failed:', err instanceof Error ? err.name : 'error'); // the structured intake line has the reason
    if (err instanceof MimeExtractError) return refuse(/No DMARC attachment|No MIME headers|boundary/i.test(err.message) ? 'no_attachment' : 'archive_invalid', `Could not extract attachment: ${err.message}`);
    return refuse('archive_invalid', 'Unexpected error reading email');
  }

  // 1b. Who sent it? The carrier (authenticated? which registry entries match?) is classified from the message alone; the tier is decided
  //     once the report's metadata is known. org_name/Submitter/subject never decide anything.
  const carrier = opts.carrier ?? carrierFromHeaders(authHeaders, tenant.env);
  // A self-hosted server that counts every report (the default) has no one to defend against: its own mail provider sends the reports, and with AUTHSERV_*
  // unset every one of them is "unauthenticated". Tier restrictions (records cap, IP lookups, decompression cap) apply where unrecognised mail does not count.
  const unrestricted = getMode(tenant.env) !== 'saas' && reportCounting(tenant.env) === 'all';
  const maxBytes = opts.maxBytes ?? (unrestricted || carrier.class === 'registry' ? limits.maxDecompressedBytes : Math.min(limits.nonRegistryDecompressedBytes, limits.maxDecompressedBytes));
  const dec: { v: TierDecision | null } = { v: null };
  const trace = (extra: Partial<ReportResult> = {}): Partial<ReportResult> => ({ tier: dec.v?.tier ?? null, identity: dec.v?.identity ?? null, reporter: dec.v?.identity ?? null, dkimOrg: carrier.dkimOrg, fromOrg: carrier.fromOrg, emailMatched: dec.v?.emailMatched ?? null, ...extra });

  // 2. Parse the DMARC XML. The gate runs once the header is known (before any per-record work): it finds the domain, skips a
  //    duplicate and applies the stored-records caps.
  const found: { domain: { id: number; domain: string } | null } = { domain: null };
  let policyDomain = '';
  const gate = async (info: { report_id: string; policy_domain: string; report_email: string | null; record_count: number }) => {
    policyDomain = info.policy_domain;
    if (opts.expectedDomain !== undefined && normalizeDomain(info.policy_domain) !== opts.expectedDomain) throw new ParseStop('refused', 'report_domain_mismatch');
    if (opts.token) {
      // Hosted: the token's domain or a subdomain of it. Filed under the token's domain, unless the subdomain is itself
      // a verified domain of the same workspace (the scoped lookup never sees another workspace's domains).
      const p = normalizeDomain(info.policy_domain);
      if (!coversDomain(opts.token.domain, p)) found.domain = null;
      else if (p === normalizeDomain(opts.token.domain)) found.domain = await tenant.scope.domains.getById(opts.token.id);
      else {
        // The subdomain's own row only while its ownership is proven; an unproven ('legacy') row never receives reports.
        const own = await tenant.scope.domains.getByName(p);
        found.domain = own && own.verified_via !== 'legacy' ? own : await tenant.scope.domains.getById(opts.token.id);
      }
    } else {
      found.domain = await resolveDomain(tenant, info.policy_domain);
    }
    const domain = found.domain;
    // Self-host keeps its message (one tenant, the sender is its own mail provider). Hosted does not echo the sender's text back into the
    // SMTP response: it is attacker-chosen (up to 253 characters), may be copied into bounce mail by an intermediate server, and the hosted
    // answer must not hint at what a domain is registered as. Same text for an unregistered domain and one another workspace owns.
    if (!domain) throw new ParseStop('refused', 'domain_not_owned', opts.token ? REASONS.domain_not_owned : `Unknown domain ${info.policy_domain} — not a registered Ready Set Mail inbox`);
    const decision = decideTier(carrier, { email: info.report_email });
    dec.v = decision;
    // Dedup AFTER the sender is classified, keyed on (domain, reporter identity, report id): a forger cannot squat a real reporter's id, and
    // an uncounted report never displaces a counted one.
    if (await tenant.scope.reports.isDuplicate(domain.id, decision.identity, info.report_id, decision.tier === 'counted')) throw new ParseStop('duplicate', 'duplicate');
    const tierCap = unrestricted ? limits.recordsPerReport : decision.tier === 'unauthenticated' ? limits.unauthRecordsPerReport : decision.tier === 'unknown' ? limits.unknownRecordsPerReport : limits.recordsPerReport;
    if (info.record_count > tierCap) throw new ParseStop('refused', 'too_many_records', `Report has ${info.record_count} records; the limit is ${tierCap}`);
    const over = opts.admitTier?.(decision.tier) ?? opts.admit?.(info.record_count, decision.tier) ?? null;
    if (over) throw new ParseStop('refused', over);
    // IP enrichment: a registry reporter gets the normal budget, an authenticated unknown a small one, an unauthenticated report none.
    return decision.tier === 'unauthenticated' && !unrestricted ? { enrich: false } : { enrich: true, maxNewIps: decision.tier === 'unknown' && !unrestricted ? Math.min(limits.newIpsPerReport, limits.unknownNewIpsPerReport) : limits.newIpsPerReport };
  };

  let report;
  let rawXml: string | null = null;
  try {
    report = await parseDmarcEmail(bytes, false, tenant.db, {
      maxBytes,
      maxRecords: opts.maxRecords ?? limits.recordsPerReport,
      maxNewIps: opts.maxNewIps ?? limits.newIpsPerReport,
      ...(opts.now !== undefined && { now: opts.now }),
      gate,
    });

    // Best-effort: store raw XML for plain XML attachments (gz/zip → null), only where raw XML is kept at all (hosted keeps none)
    try {
      if (rawXmlRetentionDays(tenant.env) <= 0) throw new Error('not kept');
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      if (decoded.trimStart().startsWith('<?xml') || decoded.trimStart().startsWith('<feed')) {
        rawXml = decoded;
      }
    } catch {
      // Binary attachment — rawXml stays null
    }
  } catch (err) {
    if (err instanceof ParseStop) {
      if (err.outcome === 'duplicate') return result('duplicate', 'duplicate', trace({ dedup: 'duplicate' }));
      // A registry reporter over a cap: accepted, not stored, counted for the owner, never a 5xx (see ReportOptions.dropOverCap).
      if ((opts.dropOverCap || carrier.class === 'registry') && dec.v?.tier === 'counted' && err.code.startsWith('cap_') && found.domain) {
        const at = opts.now ?? Math.floor(Date.now() / 1000);
        await tenant.scope.intake.markFailure(found.domain.id, today(), 'over_cap_accepted_dropped', at).catch(() => 0);
        // The COUNTED storage budget is full: say so loudly, once per reporter, with the time of the first drop (src/reports/visibility.ts, the setup check).
        if (STORAGE_CAPS.has(err.code)) await tenant.scope.intake.markDrop(found.domain.id, dec.v.identity, dec.v.knownAs ?? dec.v.identity, at).catch(() => undefined);
        return result('accepted', 'over_cap_accepted_dropped', trace());
      }
      return refuse(err.code as ReasonCode, err.message === err.code ? REASONS[err.code as ReasonCode] : err.message, trace());
    }
    if (err instanceof ParseEmailError) {
      const code = (err.code && err.code in REASONS ? err.code : 'xml_invalid') as ReasonCode;
      const detail = code === 'xml_invalid' || code === 'archive_invalid' || code === 'wrong_attachment_type' || code === 'too_many_records' || code === 'field_too_long' || code === 'date_range_invalid'
        ? `Invalid DMARC report: ${err.message}` : REASONS[code];
      return refuse(code, code === 'kind_mismatch_tlsrpt_to_rua' || code === 'decompressed_too_large' ? REASONS[code] : detail, trace());
    }
    return refuse('xml_invalid', 'Unexpected error parsing DMARC report', trace());
  }

  const domain = found.domain!;
  const tierDecision = dec.v!;

  // Hosted: every record must be about the report's own domain or a subdomain of it. As TLS-RPT does for policy domains, one record
  // about anything else refuses the whole report, and nothing is stored.
  if (opts.token && report.records.some((r) => !coversDomain(report.policy_published.domain, r.identifiers?.header_from ?? ''))) {
    return refuse('record_domain_mismatch', REASONS.record_domain_mismatch, trace({ records: report.records.length }));
  }
  const reporter: ReporterInfo = reporterInfo(carrier, tierDecision);

  // Authenticated, self-consistent, not in the registry: a CANDIDATE for the registry. Listed for the instance owner and logged on every message.
  if (tierDecision.tier === 'unknown' && carrier.authenticated && carrier.from && carrier.dkimOrg) {
    const day = today();
    // org_name, the report email and the From address are the SENDER'S text: no control characters, at most 64 characters, in the log line and in the list the owner reads.
    const orgName = senderText(report.report_metadata.org_name);
    const reportEmail = senderText(report.report_metadata.org_email).toLowerCase();
    const from = senderText(carrier.from).toLowerCase();
    logReporterCandidate({ dkim_org: carrier.dkimOrg, from: senderText(carrier.from.slice(carrier.from.lastIndexOf('@') + 1)), org_name: orgName, report_email: reportEmail, reason: tierDecision.reason });
    await globalQueries(tenant.db).reporterCandidates.note({ dkimOrg: carrier.dkimOrg, from, reportEmail, orgName, workspaceId: tenant.workspaceId, day }).catch(() => undefined);
  }

  const failureCount = report.records.reduce((sum, r) => sum + (r.count ?? 0) * (r.policy_evaluated?.dkim === 'fail' || r.policy_evaluated?.spf === 'fail' ? 1 : 0), 0);
  const known = { failure_count: failureCount, records: report.records.length, ...trace() };

  // 4. Store in D1: one batch, all or nothing
  try {
    const stored = await storeReport(tenant, domain.id, report, rawXml, true, reporter);
    if (stored.stored) return result('accepted', 'ok', { ...known, dedup: stored.superseded ? 'superseded' : 'new' });
    // Lost the race to a concurrent delivery of the same report: nothing was written, which is the right outcome.
    return result('duplicate', 'duplicate', { ...known, dedup: 'duplicate' });
  } catch (err) {
    console.error('dmarc-report: D1 storage failed for domain', domain.id, err instanceof Error ? err.message : err);
    // Nothing of the report was stored (one transaction). Count it where the owner can see it; this is best effort and
    // must not hide the original failure.
    try { await tenant.scope.intake.markFailure(domain.id, today(), 'storage_failed', Math.floor(Date.now() / 1000)); } catch { /* the marker is a courtesy */ }
    // A report that keeps failing is refused for good ONLY when its sender is not a known reporter, and counted PER MESSAGE (domain + reporter identity +
    // report id): one database outage must not turn every later report of the domain into a permanent refusal, and a known reporter's report is never
    // refused because of OUR storage failure (it is retried; the owner sees the failure count). Self-host counting every report is not defended either.
    if (tierDecision.tier !== 'counted' && !unrestricted) {
      const key = await messageKey(domain.id, tierDecision.identity, report.report_metadata.report_id);
      let failuresOfThisMessage = 1;
      try { failuresOfThisMessage = await tenant.scope.intake.noteStorageFailure(key, today()); } catch { /* best effort */ }
      if (failuresOfThisMessage > limits.storageRetriesPerDay) return refuse('storage_failed_repeatedly', REASONS.storage_failed_repeatedly, known);
    }
    throw new StorageFailure(known, err);
  }
}

/** D1 failed while storing a report that was valid: the delivery must fail so the sender retries; carries what the log needs. */
export class StorageFailure extends Error {
  readonly reason: ReasonCode = 'storage_failed';
  constructor(readonly known: Partial<ReportResult>, readonly original: unknown) {
    super(`D1 storage failed: ${original instanceof Error ? original.message : String(original)}`);
    this.name = 'StorageFailure';
  }
}
