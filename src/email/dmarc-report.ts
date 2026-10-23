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
import { coversDomain, type TokenDomain } from '../hosted/scope';
import { MAX_REPORT_BYTES } from '../hosted/config';
import { normalizeDomain } from '@inbox-angel/dns-checks';
import { storeReport } from '../dmarc/store-report';
import { reporterAuth } from '../dmarc/reporter-auth';
import { readAuthHeaders, type AuthHeaders } from './sender-proof';

export interface ReportOptions {
  /** Cap on the decompressed report (default MAX_REPORT_BYTES, which also bounds zip/gzip bombs in self-host). */
  maxBytes?: number;
  /** Hosted intake: refuse reports with more records than this, before any per-record lookup. */
  maxRecords?: number;
  /** Hosted intake: uncached source IPs enriched per report. */
  maxNewIps?: number;
  /**
   * Hosted intake: the domain the recipient's token belongs to. The report's policy_published domain must be that
   * domain or a subdomain of it; it is filed under the token's domain, or under the subdomain's own row when the same
   * workspace has it as a verified domain. Anything else is rejected.
   */
  token?: TokenDomain;
  /** The topmost results headers, when the caller has already read them (hosted intake does, to pick the allowance). */
  authHeaders?: AuthHeaders;
}

export async function handleDmarcReport(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  opts: ReportOptions = {},
): Promise<{ failure_count: number }> {
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
    report = await parseDmarcEmail(bytes, false, tenant.db, {
      maxBytes: opts.maxBytes ?? MAX_REPORT_BYTES,
      ...(opts.maxRecords !== undefined && { maxRecords: opts.maxRecords }),
      ...(opts.maxNewIps !== undefined && { maxNewIps: opts.maxNewIps }),
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
    const reason = err instanceof ParseEmailError
      ? `Invalid DMARC report: ${err.message}`
      : 'Unexpected error parsing DMARC report';
    console.error('dmarc-report: parse failed', err);
    message.setReject(reason);
    return { failure_count: 0 };
  }

  // 3. Resolve domain from the policy_domain in the report
  const policyDomain = report.policy_published.domain;
  let domain;
  if (opts.token) {
    // Hosted: the token's domain or a subdomain of it. Filed under the token's domain, unless the subdomain is itself
    // a verified domain of the same workspace (the scoped lookup never sees another workspace's domains).
    const p = normalizeDomain(policyDomain);
    if (!coversDomain(opts.token.domain, p)) domain = null;
    else if (p === normalizeDomain(opts.token.domain)) domain = await tenant.scope.domains.getById(opts.token.id);
    else domain = (await tenant.scope.domains.getByName(p)) ?? (await tenant.scope.domains.getById(opts.token.id));
  } else {
    domain = await resolveDomain(tenant, policyDomain);
  }
  if (!domain) {
    console.warn('dmarc-report: no domain found for policy_domain', policyDomain);
    message.setReject(`Unknown domain ${policyDomain} — not a registered InboxAngel inbox`);
    return { failure_count: 0 };
  }

  const failureCount = report.records.reduce((sum, r) => sum + (r.count ?? 0) * (r.policy_evaluated?.dkim === 'fail' || r.policy_evaluated?.spf === 'fail' ? 1 : 0), 0);

  // 4. Store in D1 (dedup handled by INSERT OR IGNORE inside storeReport)
  try {
    const result = await storeReport(tenant, domain.id, report, rawXml, true, reporterAuth(authHeaders, report.report_metadata, tenant.env));
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
