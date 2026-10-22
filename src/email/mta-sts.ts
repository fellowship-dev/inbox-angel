// MTA-STS provisioning — RFC 8461
//
// Protects SMTP transport by telling remote MTAs to enforce TLS when delivering
// to this domain. Requires three things:
//   1. _mta-sts.domain.com TXT "v=STSv1; id=TIMESTAMP"
//   2. https://mta-sts.domain.com/.well-known/mta-sts.txt  (served by this Worker)
//   3. _smtp._tls.domain.com TXT "v=TLSRPTv1; rua=mailto:tls-rpt@REPORTS_DOMAIN"
//
// The CNAME mta-sts.domain.com → WORKER_HOST is also provisioned so the Worker
// can serve the policy file on the correct hostname over CF's Universal SSL.

// The pure parts (DoH lookups, policy parsing/building, policy ids) live in
// packages/dns-checks; this module adds the Cloudflare zone API provisioning on top.

import { MtaStsMode } from '../db/types';
import { getZoneId, reportsDomain } from '../env-utils';
import { logAudit } from '../audit/log';
import {
  buildPolicyFile,
  createResolver,
  detectExistingMtaStsMode as detectExistingMtaStsModePure,
  generatePolicyId,
  lookupMx,
} from '@inbox-angel/dns-checks';

export { buildPolicyFile, generatePolicyId };

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Optional audit context for self-logging DNS mutations. */
export interface MtaStsAuditOpts {
  db: D1Database;
  domain_name: string;
  actor_id?: string | null;
  actor_email?: string | null;
  actor_type?: 'user' | 'system';
  ctx?: ExecutionContext;
}

export interface MtaStsProvisionEnv {
  CLOUDFLARE_API_TOKEN: string;
  WORKER_NAME: string;      // e.g. inbox-angel-worker
}

export interface MtaStsProvisionResult {
  mta_sts_record_id: string;
  tls_rpt_record_id: string;
  cname_record_id: string;
  mx_hosts: string[];
  policy_id: string;
  mode: MtaStsMode;
}

export interface MtaStsDeprovisionEnv {
  CLOUDFLARE_API_TOKEN: string;
}

// ── DNS helpers ───────────────────────────────────────────────

/**
 * Mode of an already-published policy (to "preserve existing" on first enable), or null if none.
 * Throws on DNS/network failure: a transient error must not look like "no policy" and reset
 * an enforce policy to testing.
 */
export async function detectExistingMtaStsMode(domain: string): Promise<MtaStsMode | null> {
  return detectExistingMtaStsModePure(createResolver(), domain, reason =>
    console.warn(`[mta-sts] ${domain}: existing policy unreadable (${reason}); defaulting to testing`));
}

/**
 * Current MX hostnames for `domain` ([] when the domain has no MX / a null MX).
 * Throws on DNS failure so callers never treat an outage as "MX records removed".
 */
export async function discoverMxHosts(domain: string): Promise<string[]> {
  const mx = await lookupMx(createResolver(), domain);
  if (mx.status === 'error') throw new Error(`MX lookup for ${domain} failed: ${mx.error}`);
  return mx.hosts.map(h => h.host);
}

// ── Cloudflare DNS API ────────────────────────────────────────

function cfHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function createDnsRecord(
  env: MtaStsProvisionEnv,
  record: { type: string; name: string; content: string; ttl: number; proxied?: boolean; comment?: string },
  audit?: MtaStsAuditOpts,
): Promise<string> {
  const zoneId = getZoneId();
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: cfHeaders(env.CLOUDFLARE_API_TOKEN),
    body: JSON.stringify(record),
  });
  const data = await res.json() as { success: boolean; result?: { id: string }; errors?: { message: string }[] };
  if (!data.success || !data.result?.id) {
    const msg = data.errors?.map(e => e.message).join(', ') ?? `HTTP ${res.status}`;
    throw new Error(`CF DNS create failed for ${record.name}: ${msg}`);
  }

  if (audit) {
    logAudit(audit.db, {
      actor_id: audit.actor_id,
      actor_email: audit.actor_email,
      actor_type: audit.actor_type ?? 'user',
      action: 'dns.create',
      resource_type: 'dns_record',
      resource_id: data.result.id,
      resource_name: record.name,
      after_value: { type: record.type, name: record.name, content: record.content, proxied: record.proxied },
    }, audit.ctx);
  }

  return data.result.id;
}

export async function patchCfDnsRecord(
  env: { CLOUDFLARE_API_TOKEN: string },
  recordId: string,
  content: string,
  audit?: MtaStsAuditOpts & { beforeContent?: string },
): Promise<void> {
  const auditPayload = audit ? { opts: audit, beforeContent: audit.beforeContent } : undefined;
  await patchDnsRecord(env as MtaStsDeprovisionEnv, recordId, content, auditPayload);
}

async function patchDnsRecord(
  env: MtaStsDeprovisionEnv,
  recordId: string,
  content: string,
  audit?: { opts?: MtaStsAuditOpts; beforeContent?: string },
): Promise<void> {
  const zoneId = getZoneId();
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PATCH',
    headers: cfHeaders(env.CLOUDFLARE_API_TOKEN),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const data = await res.json() as { errors?: { message: string }[] };
    const msg = data.errors?.map(e => e.message).join(', ') ?? `HTTP ${res.status}`;
    throw new Error(`CF DNS patch failed: ${msg}`);
  }

  if (audit?.opts) {
    logAudit(audit.opts.db, {
      actor_id: audit.opts.actor_id,
      actor_email: audit.opts.actor_email,
      actor_type: audit.opts.actor_type ?? 'user',
      action: 'dns.update',
      resource_type: 'dns_record',
      resource_id: recordId,
      resource_name: audit.opts.domain_name ? `_mta-sts.${audit.opts.domain_name}` : recordId,
      before_value: audit.beforeContent ? { content: audit.beforeContent } : undefined,
      after_value: { content },
    }, audit.opts.ctx);
  }
}

async function deleteDnsRecord(
  env: MtaStsDeprovisionEnv,
  recordId: string,
  audit?: MtaStsAuditOpts,
): Promise<void> {
  const zoneId = getZoneId();
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE',
    headers: cfHeaders(env.CLOUDFLARE_API_TOKEN),
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[mta-sts] delete DNS record ${recordId}: HTTP ${res.status}`);
  }

  if (audit && (res.ok || res.status === 404)) {
    logAudit(audit.db, {
      actor_id: audit.actor_id,
      actor_email: audit.actor_email,
      actor_type: audit.actor_type ?? 'user',
      action: 'dns.delete',
      resource_type: 'dns_record',
      resource_id: recordId,
      resource_name: audit.domain_name ? `dns_record.${audit.domain_name}` : recordId,
      before_value: { record_id: recordId },
    }, audit.ctx);
  }
}

// Resolve the Worker's public hostname from CF API
async function getWorkerRoute(env: MtaStsProvisionEnv, domain: string): Promise<string> {
  const zoneId = getZoneId();
  // Check existing routes for this zone
  const res = await fetch(`${CF_API}/zones/${zoneId}/workers/routes`, {
    headers: cfHeaders(env.CLOUDFLARE_API_TOKEN),
  });
  if (res.ok) {
    const data = await res.json() as { result?: { pattern: string; script: string }[] };
    const route = data.result?.find(r => r.script === env.WORKER_NAME);
    if (route) {
      // Extract hostname from route pattern like "worker.domain.com/*"
      const host = route.pattern.replace(/\/\*$/, '').replace(/^https?:\/\//, '');
      if (host && !host.includes('*')) return host;
    }
  }
  // Fallback: workers.dev subdomain (less ideal but works)
  return `${env.WORKER_NAME}.workers.dev`;
}

// ── Main entry points ─────────────────────────────────────────

/**
 * Provision all three DNS records for MTA-STS + TLS-RPT.
 * Detects existing MTA-STS setup and preserves mode if found.
 * Always defaults to 'testing' for new setups.
 */
export async function provisionMtaSts(
  domain: string,
  env: MtaStsProvisionEnv,
  audit?: MtaStsAuditOpts,
): Promise<MtaStsProvisionResult> {
  // Detect existing setup
  const existingMode = await detectExistingMtaStsMode(domain);
  const mode: MtaStsMode = existingMode ?? 'testing';

  // Discover MX hosts
  const mx_hosts = await discoverMxHosts(domain);
  if (mx_hosts.length === 0) {
    throw new Error(`No MX records found for ${domain}. Configure MX records before enabling MTA-STS.`);
  }

  const policy_id = generatePolicyId();
  const workerHost = await getWorkerRoute(env, domain);

  // Create _mta-sts TXT
  const mta_sts_record_id = await createDnsRecord(env, {
    type: 'TXT',
    name: `_mta-sts.${domain}`,
    content: `v=STSv1; id=${policy_id}`,
    ttl: 300,
    comment: `InboxAngel MTA-STS for ${domain}`,
  }, audit);

  // Create _smtp._tls TXT
  const tls_rpt_record_id = await createDnsRecord(env, {
    type: 'TXT',
    name: `_smtp._tls.${domain}`,
    content: `v=TLSRPTv1; rua=mailto:tls-rpt@${reportsDomain()}`,
    ttl: 3600,
    comment: `InboxAngel TLS-RPT for ${domain}`,
  }, audit);

  // Create mta-sts CNAME (proxied so CF handles TLS)
  const cname_record_id = await createDnsRecord(env, {
    type: 'CNAME',
    name: `mta-sts.${domain}`,
    content: workerHost,
    ttl: 1,       // 1 = auto (CF proxied)
    proxied: true,
    comment: `InboxAngel MTA-STS policy server for ${domain}`,
  }, audit);

  return { mta_sts_record_id, tls_rpt_record_id, cname_record_id, mx_hosts, policy_id, mode };
}

/**
 * Update the _mta-sts TXT record with a new policy_id (after mode or MX change).
 */
export async function updateMtaStsTxtRecord(
  recordId: string,
  policyId: string,
  env: MtaStsDeprovisionEnv,
  audit?: MtaStsAuditOpts & { oldPolicyId?: string },
): Promise<void> {
  const content = `v=STSv1; id=${policyId}`;
  const auditPayload = audit ? {
    opts: audit,
    beforeContent: audit.oldPolicyId ? `v=STSv1; id=${audit.oldPolicyId}` : undefined,
  } : undefined;
  await patchDnsRecord(env, recordId, content, auditPayload);
}

/**
 * Remove all three DNS records. Called on disable.
 */
export async function deprovisionMtaSts(
  env: MtaStsDeprovisionEnv,
  ids: { mta_sts_record_id: string | null; tls_rpt_record_id: string | null; cname_record_id: string | null },
  audit?: MtaStsAuditOpts,
): Promise<void> {
  const tasks = [ids.mta_sts_record_id, ids.tls_rpt_record_id, ids.cname_record_id]
    .filter(Boolean)
    .map(id => deleteDnsRecord(env, id!, audit).catch(e => console.warn(`[mta-sts] deprovision ${id}:`, e)));
  await Promise.all(tasks);
}
