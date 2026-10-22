// Handles inbound DMARC aggregate report emails.
// Triggered for any address other than check-*@reports.yourdomain.com.
// Flow: extract bytes → parse XML → resolve domain by policy_domain → store in D1.
//
// Routing is by report content (policy_published.domain), not by the recipient address.
// This lets self-hosters use a fixed rua=mailto:rua@reports.yourdomain.com for all domains.

import type { TenantContext } from '../tenancy/context';
import { extractAttachmentBytes, MimeExtractError } from './mime-extract';
import { resolveDomain } from './resolve-domain';
import { parseDmarcEmail, ParseEmailError } from '../dmarc/parse-email';
import { storeReport } from '../dmarc/store-report';

export async function handleDmarcReport(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
): Promise<{ failure_count: number }> {
  // 1. Extract attachment bytes from raw MIME stream
  let bytes: Uint8Array;
  try {
    bytes = await extractAttachmentBytes(message.raw);
  } catch (err) {
    const reason = err instanceof MimeExtractError
      ? `Could not extract attachment: ${err.message}`
      : 'Unexpected error reading email';
    console.error('dmarc-report: mime extraction failed', err);
    message.setReject(reason);
    return { failure_count: 0 };
  }

  // 2. Parse the DMARC XML — needed to determine which domain this report is for
  let report;
  let rawXml: string | null = null;
  try {
    report = await parseDmarcEmail(bytes, false, tenant.db);

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
    const reason = err instanceof ParseEmailError
      ? `Invalid DMARC report: ${err.message}`
      : 'Unexpected error parsing DMARC report';
    console.error('dmarc-report: parse failed', err);
    message.setReject(reason);
    return { failure_count: 0 };
  }

  // 3. Resolve domain from the policy_domain in the report
  const policyDomain = report.policy_published.domain;
  const domain = await resolveDomain(tenant, policyDomain);
  if (!domain) {
    console.warn('dmarc-report: no domain found for policy_domain', policyDomain);
    message.setReject(`Unknown domain ${policyDomain} — not a registered InboxAngel inbox`);
    return { failure_count: 0 };
  }

  const failureCount = report.records.reduce((sum, r) => sum + (r.count ?? 0) * (r.policy_evaluated?.dkim === 'fail' || r.policy_evaluated?.spf === 'fail' ? 1 : 0), 0);

  // 4. Store in D1 (dedup handled by INSERT OR IGNORE inside storeReport)
  try {
    const result = await storeReport(tenant, domain.id, report, rawXml, true);
    if (result.stored) {
      console.log(
        `dmarc-report: stored report ${report.report_metadata.report_id} ` +
        `for ${domain.domain} (id=${result.reportId}, records=${report.records.length})`
      );
    } else {
      console.log(
        `dmarc-report: duplicate report ${report.report_metadata.report_id} ` +
        `for ${domain.domain} — skipped`
      );
    }
  } catch (err) {
    // Log but don't reject — email was valid, just a storage failure
    console.error('dmarc-report: D1 storage failed for', domain.domain, err);
  }

  return { failure_count: failureCount };
}
