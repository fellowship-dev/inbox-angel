// SPF record flattener — resolves all include:/redirect= chains to raw ip4:/ip6: entries
// and updates the Cloudflare DNS TXT record in-place via CF API.
//
// RFC 7208 §4.6.4: SPF evaluators MUST limit DNS lookups to 10.
// Flattening replaces all include:/redirect= mechanisms with their resolved IPs,
// reducing lookup count to 1 (the initial TXT lookup itself).
//
// Supported: include:, redirect=, ip4:, ip6: (covers 99% of cloud mail provider SPF records)
// Out of scope (MVP): a:, mx:, ptr:, exists: — preserved verbatim if present (rare)
//
// The pure resolution logic (collectIps / buildFlatRecord) lives in packages/dns-checks;
// this module only adds the Cloudflare zone API writes on top.

import type { TenantContext } from '../tenancy/context';
import { CfError, cfErrorText, type CfDnsRecord } from '../tenancy/cf-client';
import { logAudit } from '../audit/log';
import {
  collectIps as collectIpsPure,
  createResolver,
  buildFlatRecord,
  type CollectResult,
} from '@inbox-angel/dns-checks';

export { buildFlatRecord };
export type { CollectResult };

/** Optional audit context for self-logging DNS mutations. */
export interface SpfAuditOpts {
  domain_name: string;
  actor_id?: string | null;
  actor_email?: string | null;
  actor_type?: 'user' | 'system';
  ctx?: ExecutionContext;
}

export interface SpfFlattenResult {
  canonical_record: string;   // the original record we replaced
  flattened_record: string;   // the new flat record written to DNS
  ip_count: number;           // number of ip4:/ip6: entries in flattened record
  cf_record_id: string;       // Cloudflare DNS record ID (for future PATCH)
}

// ── IP collector ──────────────────────────────────────────────

/**
 * Resolve the include:/redirect= chain of `domain` into ip4:/ip6: entries via live DNS.
 * Throws if the chain could not be fully resolved (DNS error, loop, multiple SPF records):
 * publishing a partial flattened record would silently drop senders.
 */
export async function collectIps(domain: string): Promise<CollectResult> {
  const result = await collectIpsPure(domain, createResolver());
  if (result.errors.length > 0) {
    throw new Error(`Could not fully resolve SPF for ${domain}: ${result.errors.map(e => e.message).join('; ')}`);
  }
  return result;
}

// ── Cloudflare DNS API ────────────────────────────────────────

// Find the SPF TXT record for a domain in that domain's own zone.
// Returns null if the zone has no SPF record; Cloudflare errors (auth, network, no zone) propagate.
export async function findSpfRecord(
  tenant: TenantContext,
  domain: string,
): Promise<CfDnsRecord | null> {
  const zone = await tenant.zoneFor(domain);
  const records = await tenant.requireCf().listDnsRecords(zone.id, { type: 'TXT', name: domain, per_page: 100 });
  return records.find(r => r.content.replace(/^"|"$/g, '').startsWith('v=spf1')) ?? null;
}

// PATCH an existing TXT record content in-place (in the domain's own zone).
export async function updateDnsRecord(
  tenant: TenantContext,
  recordId: string,
  domain: string,
  newContent: string,
  audit?: { opts?: SpfAuditOpts; beforeContent?: string },
): Promise<void> {
  const zone = await tenant.zoneFor(domain);
  try {
    await tenant.requireCf().patchDnsRecord(zone.id, recordId, { content: newContent });
  } catch (e) {
    if (e instanceof CfError) throw new Error(`CF DNS PATCH failed for ${domain}: ${cfErrorText(e)}`);
    throw e;
  }

  if (audit?.opts) {
    logAudit(tenant, {
      actor_id: audit.opts.actor_id,
      actor_email: audit.opts.actor_email,
      actor_type: audit.opts.actor_type ?? 'system',
      action: 'dns.update',
      resource_type: 'dns_record',
      resource_id: recordId,
      resource_name: `TXT ${domain}`,
      before_value: audit.beforeContent ? { content: audit.beforeContent } : undefined,
      after_value: { content: newContent },
    }, audit.opts.ctx);
  }
}

// ── Main entry point ──────────────────────────────────────────

/**
 * Flatten the SPF record for a domain:
 * 1. Fetch current record from CF DNS (to get record ID + canonical value)
 * 2. Walk include: chain, collect all ip4:/ip6:
 * 3. Build flat record
 * 4. PATCH CF DNS record in place
 * 5. Return result for DB storage
 */
export async function flattenSpf(
  tenant: TenantContext,
  domain: string,
  existingRecordId?: string | null,
  audit?: SpfAuditOpts,
): Promise<SpfFlattenResult> {
  // Step 1: find the live SPF record on CF
  const cfRecord = await findSpfRecord(tenant, domain);
  if (!cfRecord) {
    throw new Error(`No SPF TXT record found on Cloudflare DNS for ${domain}. Make sure the zone matches.`);
  }

  const canonical_record = cfRecord.content;
  const cf_record_id = cfRecord.id;

  // Step 2: collect all IPs recursively from live DNS
  const { ips, extra, allQualifier } = await collectIps(domain);
  if (ips.length === 0 && extra.length === 0) {
    throw new Error(`Could not resolve any IP mechanisms for ${domain}. SPF record may be empty or DNS unreachable.`);
  }

  // Step 3: build flat record
  const flattened_record = buildFlatRecord(ips, extra, allQualifier);

  // Step 4: update CF DNS
  await updateDnsRecord(tenant, cf_record_id, domain, flattened_record,
    audit ? { opts: audit, beforeContent: canonical_record } : undefined);

  return {
    canonical_record,
    flattened_record,
    ip_count: ips.length,
    cf_record_id,
  };
}

/**
 * Restore the canonical SPF record from DB storage.
 * Called when user disables SPF flattening.
 */
export async function restoreSpf(
  tenant: TenantContext,
  domain: string,
  cf_record_id: string,
  canonical_record: string,
  audit?: SpfAuditOpts,
): Promise<void> {
  await updateDnsRecord(tenant, cf_record_id, domain, canonical_record,
    audit ? { opts: audit, beforeContent: undefined } : undefined);
}
