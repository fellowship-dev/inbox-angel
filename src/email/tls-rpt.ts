// TLS-RPT report handler — RFC 8460
//
// Sending MTAs deliver JSON reports to tls-rpt@REPORTS_DOMAIN summarising
// TLS connection outcomes for the reporting period. Similar to DMARC RUA
// but JSON format (not XML) and much simpler schema.
//
// Report format:
//   { organization-name, date-range: { start-datetime, end-datetime },
//     policies: [{ policy: { policy-type, policy-string[] },
//                  summary: { total-successful-session-count, total-failure-session-count },
//                  failure-details: [{ result-type, ... }] }] }

import type { TenantContext } from '../tenancy/context';
import { extractAttachmentBytes, extractTextBody, readStream } from './mime-extract';
import { coversDomain, type TokenDomain } from '../hosted/scope';
import { extractReport, ReportTooLargeError } from '../dmarc/extract-report';
import { rawXmlRetentionDays } from '../lifecycle/config';

/** The raw report JSON to keep, or null when RAW_XML_RETENTION_DAYS=0 (raw payloads are not stored). */
const rawJson = (tenant: TenantContext, raw: string): string | null => (rawXmlRetentionDays(tenant.env) > 0 ? raw.slice(0, 65536) : null);

// RFC 8460 § 4.3 — subset of fields we care about
interface TlsRptFailureDetail {
  'result-type': string;
  'sending-mta-ip'?: string;
  'receiving-mx-hostname'?: string;
  'failed-session-count'?: number;
  'additional-information'?: string;
}

interface TlsRptPolicy {
  policy: {
    'policy-type': string;
    'policy-string'?: string[];
    'policy-domain': string;
  };
  summary: {
    'total-successful-session-count': number;
    'total-failure-session-count': number;
  };
  'failure-details'?: TlsRptFailureDetail[];
}

interface TlsRptReport {
  'organization-name': string;
  'date-range': {
    'start-datetime': string;
    'end-datetime': string;
  };
  'contact-info'?: string;
  'report-id'?: string;
  policies: TlsRptPolicy[];
}

function parseIsoDate(s: string): number {
  const d = new Date(s);
  return isNaN(d.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(d.getTime() / 1000);
}

export interface TlsRptOptions {
  /**
   * Hosted intake. Reports may be gzip/zip attachments (as RFC 8460 senders usually send them), capped at
   * `maxBytes` once decompressed, and every policy must be for a domain this workspace owns or the whole
   * report is rejected. Unset (self-host): plain JSON bodies, unknown domains skipped.
   */
  hosted?: { maxBytes: number; token: TokenDomain };
}

/** The report text: the JSON body, or (hosted) a gzip/zip/JSON attachment. */
async function readReport(message: ForwardableEmailMessage, opts: TlsRptOptions): Promise<string> {
  if (!opts.hosted) return extractTextBody(message.raw);
  const all = await readStream(message.raw);
  try {
    return extractReport(await extractAttachmentBytes(new Response(all).body!), { maxBytes: opts.hosted.maxBytes });
  } catch (e) {
    if (e instanceof ReportTooLargeError) throw e;
    // No usable attachment: the report is the message body.
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(all);
  }
}

/** Hosted: every policy is for the token's domain or a subdomain, so they file as one row under the token's domain. */
async function storeHostedTlsRpt(
  report: TlsRptReport, raw: string, orgName: string, dateBegin: number, dateEnd: number, tenant: TenantContext, token: TokenDomain,
): Promise<{ failure_count: number }> {
  const domain = await tenant.scope.domains.getById(token.id);
  if (!domain) return { failure_count: 0 };
  let success = 0;
  let failure = 0;
  const details: unknown[] = [];
  for (const policy of report.policies) {
    success += policy.summary?.['total-successful-session-count'] ?? 0;
    failure += policy.summary?.['total-failure-session-count'] ?? 0;
    details.push(...(policy['failure-details'] ?? []));
  }
  try {
    await tenant.scope.reports.insertTls({
      domain_id: domain.id, org_name: orgName, date_begin: dateBegin, date_end: dateEnd,
      total_success: success, total_failure: failure,
      failure_details: details.length ? JSON.stringify(details) : null,
      raw_json: rawJson(tenant, raw),
    });
  } catch (e) {
    console.error(`[tls-rpt] insert failed for ${domain.domain}:`, e);
  }
  console.log(`[tls-rpt] stored report from ${orgName} for ${domain.domain}`);
  return { failure_count: failure };
}

export async function handleTlsRptReport(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  opts: TlsRptOptions = {},
): Promise<{ failure_count: number }> {

  // Extract the JSON (a plain body; hosted intake also accepts compressed attachments)
  let raw: string;
  try {
    raw = await readReport(message, opts);
  } catch (e) {
    console.error('[tls-rpt] failed to extract email body:', e);
    message.setReject(e instanceof ReportTooLargeError ? 'TLS-RPT report is too large' : 'Could not read TLS-RPT report email body');
    return { failure_count: 0 };
  }

  // Parse JSON — find the JSON blob (may be after headers/preamble)
  let report: TlsRptReport;
  try {
    // Find first { to skip any MIME preamble
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object found');
    report = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    console.error('[tls-rpt] JSON parse failed:', e);
    message.setReject('Invalid TLS-RPT report JSON');
    return { failure_count: 0 };
  }

  const orgName = report['organization-name'] ?? 'Unknown';
  const dateBegin = parseIsoDate(report['date-range']?.['start-datetime']);
  const dateEnd   = parseIsoDate(report['date-range']?.['end-datetime']);

  // Hosted: a report naming a domain this workspace doesn't own is spoofed or misrouted. Reject it whole, store nothing.
  if (opts.hosted) {
    if (!Array.isArray(report.policies) || report.policies.length === 0) {
      message.setReject('Invalid TLS-RPT report: no policies');
      return { failure_count: 0 };
    }
    for (const policy of report.policies ?? []) {
      const policyDomain = policy.policy?.['policy-domain'];
      if (!policyDomain || !coversDomain(opts.hosted.token.domain, policyDomain)) {
        console.warn(`[tls-rpt] policy-domain ${policyDomain ?? '(none)'} is outside the token's domain`);
        message.setReject(`Unknown domain ${policyDomain ?? '(none)'} — not a registered InboxAngel inbox`);
        return { failure_count: 0 };
      }
    }
    return storeHostedTlsRpt(report, raw, orgName, dateBegin, dateEnd, tenant, opts.hosted.token);
  }

  let stored = 0;
  let totalFailureCount = 0;
  for (const policy of report.policies ?? []) {
    const policyDomain = policy.policy?.['policy-domain'];
    if (!policyDomain) continue;

    const domain = await tenant.scope.domains.getByName(opts.hosted ? policyDomain.toLowerCase() : policyDomain);
    if (!domain) {
      console.warn(`[tls-rpt] unknown domain ${policyDomain} — skipping policy`);
      continue;
    }

    const totalSuccess = policy.summary?.['total-successful-session-count'] ?? 0;
    const totalFailure = policy.summary?.['total-failure-session-count'] ?? 0;
    totalFailureCount += totalFailure;
    const failureDetails = policy['failure-details']?.length
      ? JSON.stringify(policy['failure-details'])
      : null;

    try {
      await tenant.scope.reports.insertTls({
        domain_id: domain.id,
        org_name: orgName,
        date_begin: dateBegin,
        date_end: dateEnd,
        total_success: totalSuccess,
        total_failure: totalFailure,
        failure_details: failureDetails,
        raw_json: stored === 0 ? rawJson(tenant, raw) : null, // store raw on first policy only
      });
      stored++;
    } catch (e) {
      console.error(`[tls-rpt] insert failed for ${policyDomain}:`, e);
    }
  }

  console.log(`[tls-rpt] stored ${stored} policy report(s) from ${orgName}`);
  return { failure_count: totalFailureCount };
}
