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

import { Env } from '../index';
import { extractTextBody } from './mime-extract';
import { scope } from '../db/scope';

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

export async function handleTlsRptReport(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<{ failure_count: number }> {
  if (!env.DB) return { failure_count: 0 };

  // Extract JSON from email body (TLS-RPT reports are plain JSON, not attachments)
  let raw: string;
  try {
    raw = await extractTextBody(message.raw);
  } catch (e) {
    console.error('[tls-rpt] failed to extract email body:', e);
    message.setReject('Could not read TLS-RPT report email body');
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

  let stored = 0;
  let totalFailureCount = 0;
  for (const policy of report.policies ?? []) {
    const policyDomain = policy.policy?.['policy-domain'];
    if (!policyDomain) continue;

    const domain = await scope(env.DB).domains.getByName(policyDomain);
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
      await scope(env.DB).reports.insertTls({
        domain_id: domain.id,
        org_name: orgName,
        date_begin: dateBegin,
        date_end: dateEnd,
        total_success: totalSuccess,
        total_failure: totalFailure,
        failure_details: failureDetails,
        raw_json: stored === 0 ? raw.slice(0, 65536) : null, // store raw on first policy only
      });
      stored++;
    } catch (e) {
      console.error(`[tls-rpt] insert failed for ${policyDomain}:`, e);
    }
  }

  console.log(`[tls-rpt] stored ${stored} policy report(s) from ${orgName}`);
  return { failure_count: totalFailureCount };
}
