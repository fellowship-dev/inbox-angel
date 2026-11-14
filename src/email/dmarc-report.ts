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
import { normalizeDomain } from '@inbox-angel/dns-checks';
import { storeReport } from '../dmarc/store-report';
import { reporterAuth } from '../dmarc/reporter-auth';
import { readAuthHeaders, type AuthHeaders } from './sender-proof';
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
   * Called with the report's record count once its domain is known and it is not a duplicate: return a reason to refuse it (a cap
   * on stored records), else null. Nothing was enriched or stored yet.
   */
  admit?: (recordCount: number) => ReasonCode | null;
  /** The clock, unix seconds (tests). */
  now?: number;
}

export interface ReportResult {
  failure_count: number;
  outcome: Outcome;
  reason: ReasonCode;
  /** Records in the report (null: it was not parsed far enough to know). */
  records: number | null;
  /** The reporting organisation's domain as the report names it, null when unknown. */
  reporter: string | null;
  /** Did the receiver prove the reporter (null: not judged). */
  proven: boolean | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function handleDmarcReport(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  opts: ReportOptions = {},
): Promise<ReportResult> {
  const result = (outcome: Outcome, reason: ReasonCode, extra: Partial<ReportResult> = {}): ReportResult =>
    ({ failure_count: 0, outcome, reason, records: null, reporter: null, proven: null, ...extra });
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

  // 2. Parse the DMARC XML. The gate runs once the header is known (before any per-record work): it finds the domain, skips a
  //    duplicate and applies the stored-records caps.
  const found: { domain: { id: number; domain: string } | null } = { domain: null };
  let policyDomain = '';
  const gate = async (info: { report_id: string; policy_domain: string; record_count: number }) => {
    policyDomain = info.policy_domain;
    if (opts.token) {
      // Hosted: the token's domain or a subdomain of it. Filed under the token's domain, unless the subdomain is itself
      // a verified domain of the same workspace (the scoped lookup never sees another workspace's domains).
      const p = normalizeDomain(info.policy_domain);
      if (!coversDomain(opts.token.domain, p)) found.domain = null;
      else if (p === normalizeDomain(opts.token.domain)) found.domain = await tenant.scope.domains.getById(opts.token.id);
      else found.domain = (await tenant.scope.domains.getByName(p)) ?? (await tenant.scope.domains.getById(opts.token.id));
    } else {
      found.domain = await resolveDomain(tenant, info.policy_domain);
    }
    const domain = found.domain;
    if (!domain) throw new ParseStop('refused', 'domain_not_owned', `Unknown domain ${info.policy_domain} — not a registered InboxAngel inbox`);
    if (await tenant.scope.reports.findReportId(domain.id, info.report_id)) throw new ParseStop('duplicate', 'duplicate');
    const over = opts.admit?.(info.record_count) ?? null;
    if (over) throw new ParseStop('refused', over);
  };

  let report;
  let rawXml: string | null = null;
  try {
    report = await parseDmarcEmail(bytes, false, tenant.db, {
      maxBytes: opts.maxBytes ?? limits.maxDecompressedBytes,
      maxRecords: opts.maxRecords ?? limits.recordsPerReport,
      maxNewIps: opts.maxNewIps ?? limits.newIpsPerReport,
      ...(opts.now !== undefined && { now: opts.now }),
      gate,
    });

    // Best-effort: store raw XML for plain XML attachments (gz/zip → null)
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      if (decoded.trimStart().startsWith('<?xml') || decoded.trimStart().startsWith('<feed')) {
        rawXml = decoded;
      }
    } catch {
      // Binary attachment — rawXml stays null
    }
  } catch (err) {
    if (err instanceof ParseStop) {
      if (err.outcome === 'duplicate') {
        return result('duplicate', 'duplicate');
      }
      return refuse(err.code as ReasonCode, err.message === err.code ? REASONS[err.code as ReasonCode] : err.message);
    }
    if (err instanceof ParseEmailError) {
      const code = (err.code && err.code in REASONS ? err.code : 'xml_invalid') as ReasonCode;
      const detail = code === 'xml_invalid' || code === 'archive_invalid' || code === 'wrong_attachment_type' || code === 'too_many_records' || code === 'field_too_long' || code === 'date_range_invalid'
        ? `Invalid DMARC report: ${err.message}` : REASONS[code];
      return refuse(code, code === 'kind_mismatch_tlsrpt_to_rua' || code === 'decompressed_too_large' ? REASONS[code] : detail);
    }
    return refuse('xml_invalid', 'Unexpected error parsing DMARC report');
  }

  const domain = found.domain!;

  // 3. Judge the sender against the report's own claim (hosted and self-host alike; nothing is proven without AUTHSERV_*)
  const auth = reporterAuth(authHeaders, report.report_metadata, tenant.env);
  const failureCount = report.records.reduce((sum, r) => sum + (r.count ?? 0) * (r.policy_evaluated?.dkim === 'fail' || r.policy_evaluated?.spf === 'fail' ? 1 : 0), 0);
  const known = { failure_count: failureCount, records: report.records.length, reporter: auth.domain, proven: auth.result === 'pass' };

  // 4. Store in D1: one batch, all or nothing
  try {
    const stored = await storeReport(tenant, domain.id, report, rawXml, true, auth);
    if (stored.stored) return result('accepted', 'ok', known);
    // Lost the race to a concurrent delivery of the same report: nothing was written, which is the right outcome.
    return result('duplicate', 'duplicate', known);
  } catch (err) {
    console.error('dmarc-report: D1 storage failed for domain', domain.id, err instanceof Error ? err.message : err);
    // Nothing of the report was stored (one transaction). Count it where the owner can see it; this is best effort and
    // must not hide the original failure.
    let failuresToday = 1;
    try { failuresToday = await tenant.scope.intake.markFailure(domain.id, today(), 'storage_failed', Math.floor(Date.now() / 1000)); } catch { /* the marker is a courtesy */ }
    if (failuresToday > limits.storageRetriesPerDay) {
      // The same failure again and again: stop the sender from retrying a message we cannot store.
      return refuse('storage_failed_repeatedly', REASONS.storage_failed_repeatedly, known);
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
