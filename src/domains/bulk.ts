// Bulk domain import — admin-only fast path.
// Accepts a list of domains, inserts valid/new ones, provisions DNS for each.
// Returns per-domain status without throwing on partial failure.

import { scope } from '../db/scope';
import { provisionDomain } from '../dns/provision';
import { reportsDomain } from '../env-utils';
import { logAudit } from '../audit/log';

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const BATCH_LIMIT = 50;

export type BulkImportStatus = 'imported' | 'duplicate' | 'invalid' | 'error';

export interface BulkImportResult {
  domain: string;
  status: BulkImportStatus;
  error?: string;
  dns_record_id?: string | null;
  manual_dns?: boolean;
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

interface BulkEnv {
  DB: D1Database;
  CLOUDFLARE_API_TOKEN?: string;
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
  env: BulkEnv,
  domains: string[],
  audit: AuditOpts = {},
): Promise<BulkImportResult[]> {
  const rdomain = reportsDomain();
  const batch = domains.slice(0, BATCH_LIMIT);
  const results: BulkImportResult[] = [];

  for (const domain of batch) {
    if (!validateDomain(domain)) {
      results.push({ domain, status: 'invalid', error: 'invalid domain format' });
      continue;
    }

    // Dedup check
    const existing = await scope(env.DB).domains.getByName(domain);
    if (existing) {
      results.push({ domain, status: 'duplicate' });
      continue;
    }

    const ruaAddress = rdomain ? `rua@${rdomain}` : `rua@reports.inboxangel.io`;

    let domainId: number;
    try {
      const result = await scope(env.DB).domains.insert({ domain, rua_address: ruaAddress });
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

    logAudit(env.DB, {
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
        { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? '' },
        domain,
        { db: env.DB, actor_id: audit.actorId, actor_email: audit.actorEmail, actor_type: 'user', ctx: audit.ctx },
      );
      dnsRecordId = dnsResult.recordId;
      manual = dnsResult.manual;

      if (dnsRecordId) {
        await scope(env.DB).domains.setDnsRecord(domainId, dnsRecordId, { touch: true });
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
