// Bulk domain import — admin-only fast path.
// Accepts a list of domains, inserts valid/new ones, provisions DNS for each.
// Returns per-domain status without throwing on partial failure.

import type { TenantContext } from '../tenancy/context';
import { provisionDomain } from '../dns/provision';
import { logAudit } from '../audit/log';
import { PlanLimitError } from '@inbox-angel/db';
import { planLimitBody } from '../hosted/plan-limits';
import { normalizeDomainName } from '@inbox-angel/dns-checks';
import { domainCap, domainRefusal } from './service';
import { admitDomain, claimView, settleClaims, type ClaimView } from './ownership';

const BATCH_LIMIT = 50;

export const REPORTS_DOMAIN_MISSING = 'Reports domain not configured — complete the setup wizard first';

export type BulkImportStatus = 'imported' | 'duplicate' | 'invalid' | 'error' | 'pending';

export interface BulkImportResult {
  domain: string;
  status: BulkImportStatus;
  error?: string;
  /** 'plan_limit': the workspace is at its hosted domain cap; this row and every row after it were not attempted. */
  code?: 'plan_limit';
  /** With code 'plan_limit': where to ask for more (https only), or null. */
  help_url?: string | null;
  dns_record_id?: string | null;
  manual_dns?: boolean;
  /** status 'pending' (SaaS): the TXT record that proves ownership. Nothing else is done for the domain until it is verified. */
  claim?: ClaimView;
}

function atCapRow(tenant: TenantContext, domain: string, max: number): BulkImportResult {
  const { error, help_url } = planLimitBody(tenant.env, 'domains_per_workspace', max);
  return { domain, status: 'error', error, code: 'plan_limit', help_url };
}

export function validateDomain(domain: string): boolean {
  return normalizeDomainName(domain).ok;
}

/** Parse a newline- or comma-separated domain list into unique, lowercase entries. */
export function parseDomainList(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(/[\n,]+/)) {
    const d = raw.trim().toLowerCase();
    if (d && !seen.has(d)) {
      seen.add(d);
      result.push(d);
    }
  }
  return result;
}

interface AuditOpts {
  actorId?: string | null;
  actorEmail?: string | null;
  ctx?: ExecutionContext;
}

/**
 * Insert each domain in the list, provision DNS, and return per-row status.
 * Caps at BATCH_LIMIT entries; excess entries are omitted from results.
 * Throws when no reports domain is configured: aggregate reports must go to a domain this instance runs.
 */
export async function bulkInsertDomains(
  tenant: TenantContext,
  domains: string[],
  audit: AuditOpts = {},
): Promise<BulkImportResult[]> {
  const rdomain = tenant.settings.reportsDomain;
  if (!rdomain) throw new Error(REPORTS_DOMAIN_MISSING);
  const ruaAddress = `rua@${rdomain}`;
  const batch = domains.slice(0, BATCH_LIMIT);
  const results: BulkImportResult[] = [];
  const cap = domainCap(tenant);
  let atCap = false;
  // One count up front, then a local tally. It is advisory: the capped INSERT below is what enforces the cap, so a stale tally
  // can only send a row to that insert, never past the cap.
  let held = cap === undefined ? 0 : (await tenant.scope.domains.list()).length;

  for (const typed of batch) {
    const named = normalizeDomainName(typed);
    if (!named.ok) {
      results.push({ domain: typed, status: 'invalid', error: domainRefusal(named).error });
      continue;
    }
    const domain = named.domain;

    // Dedup check
    const existing = await tenant.scope.domains.getByName(domain);
    if (existing) {
      results.push({ domain, status: 'duplicate' });
      continue;
    }

    // Advisory (see service.ts): a domain that can never be added gets no claim. The INSERT below is what enforces the cap.
    if (cap !== undefined && (atCap || held >= cap)) { atCap = true; results.push(atCapRow(tenant, domain, cap)); continue; }

    const admission = await admitDomain(tenant, domain);
    if (admission.kind === 'taken') { results.push({ domain, status: 'duplicate', error: 'already registered in another workspace' }); continue; }
    if (admission.kind === 'limit') { results.push({ domain, status: 'error', error: 'too many unverified domains — verify or remove some first' }); continue; }
    if (admission.kind === 'pending') { results.push({ domain, status: 'pending', claim: claimView(admission.claim) }); continue; }

    let domainId: number;
    try {
      const result = await tenant.scope.domains.insert({ domain, rua_address: ruaAddress, verified_via: admission.via }, undefined, { maxDomains: cap });
      domainId = result.meta.last_row_id as number;
      held++;
    } catch (e: unknown) {
      if (e instanceof PlanLimitError) { atCap = true; results.push(atCapRow(tenant, domain, e.max)); continue; }
      const msg = e instanceof Error ? e.message : String(e);
      // Race condition: another request inserted the domain between our check and insert
      if (msg.includes('UNIQUE')) {
        results.push({ domain, status: 'duplicate' });
      } else {
        results.push({ domain, status: 'error', error: msg });
      }
      continue;
    }

    await settleClaims(tenant, domain);
    logAudit(tenant, {
      actor_id: audit.actorId ?? null,
      actor_email: audit.actorEmail ?? null,
      actor_type: 'user',
      action: 'domain.add',
      resource_type: 'domain',
      resource_id: String(domainId),
      resource_name: domain,
      after_value: { domain, rua_address: ruaAddress, source: 'bulk_import' },
    }, audit.ctx);

    // Provision the cross-domain DMARC auth record
    let dnsRecordId: string | null = null;
    let manual = false;
    try {
      const dnsResult = await provisionDomain(
        tenant,
        domain,
        { actor_id: audit.actorId, actor_email: audit.actorEmail, actor_type: 'user', ctx: audit.ctx },
      );
      dnsRecordId = dnsResult.recordId;
      manual = dnsResult.manual;

      if (dnsRecordId) {
        await tenant.scope.domains.setDnsRecord(domainId, dnsRecordId, { touch: true });
      }
    } catch (e: unknown) {
      // DNS provisioning failure is non-fatal — domain is inserted, user can provision later
      console.warn(`[bulk-import] DNS provision failed for ${domain}:`, e);
      manual = true;
    }

    results.push({ domain, status: 'imported', dns_record_id: dnsRecordId, manual_dns: manual });
  }

  return results;
}
