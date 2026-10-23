// Bulk domain import — admin-only fast path.
// Accepts a list of domains, inserts valid/new ones, provisions DNS for each.
// Returns per-domain status without throwing on partial failure.

import type { TenantContext } from '../tenancy/context';
import { provisionDomain } from '../dns/provision';
import { logAudit } from '../audit/log';
import { admitDomain, claimView, settleClaims, type ClaimView } from './ownership';

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const BATCH_LIMIT = 50;

export type BulkImportStatus = 'imported' | 'duplicate' | 'invalid' | 'error' | 'pending';

export interface BulkImportResult {
  domain: string;
  status: BulkImportStatus;
  error?: string;
  dns_record_id?: string | null;
  manual_dns?: boolean;
  /** status 'pending' (SaaS): the TXT record that proves ownership. Nothing else is done for the domain until it is verified. */
  claim?: ClaimView;
}

export function validateDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
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
 */
export async function bulkInsertDomains(
  tenant: TenantContext,
  domains: string[],
  audit: AuditOpts = {},
): Promise<BulkImportResult[]> {
  const rdomain = tenant.settings.reportsDomain;
  const batch = domains.slice(0, BATCH_LIMIT);
  const results: BulkImportResult[] = [];

  for (const domain of batch) {
    if (!validateDomain(domain)) {
      results.push({ domain, status: 'invalid', error: 'invalid domain format' });
      continue;
    }

    // Dedup check
    const existing = await tenant.scope.domains.getByName(domain);
    if (existing) {
      results.push({ domain, status: 'duplicate' });
      continue;
    }

    const admission = await admitDomain(tenant, domain);
    if (admission.kind === 'taken') { results.push({ domain, status: 'duplicate', error: 'already registered in another workspace' }); continue; }
    if (admission.kind === 'limit') { results.push({ domain, status: 'error', error: 'too many unverified domains — verify or remove some first' }); continue; }
    if (admission.kind === 'pending') { results.push({ domain, status: 'pending', claim: claimView(admission.claim) }); continue; }

    const ruaAddress = rdomain ? `rua@${rdomain}` : `rua@reports.inboxangel.io`;

    let domainId: number;
    try {
      const result = await tenant.scope.domains.insert({ domain, rua_address: ruaAddress, verified_via: admission.via });
      domainId = result.meta.last_row_id as number;
    } catch (e: unknown) {
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
