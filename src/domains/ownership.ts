// Who may monitor a domain: only a workspace that has proven it controls it.
//
//  self-host  every domain is the operator's own: verified on the spot.
//  saas       a domain starts as a *claim* (table domain_claims, not `domains`) and becomes a domain when one of these holds:
//               - parent    the workspace already verified a parent domain (`mail.acme.com` under `acme.com`)
//               - cloudflare its zone is on the allow-list of one of the workspace's active Cloudflare connections
//               - txt       the TXT record `_inboxangel.<domain>` holds the claim's token
//
// Because `domains` only ever holds verified domains, its global UNIQUE(domain) means "the first workspace to verify
// wins", and everything downstream of `domains` (reports, stats, check results, DNS writes, hosted records) never sees
// a pending claim. Several workspaces may hold a pending claim on the same name at once; when one verifies, the
// others are marked `lost`.
import { claimLookups, type DomainClaimRow } from '@inbox-angel/db';
import { createResolver, normalizeName, type Resolver } from '@inbox-angel/dns-checks';
import { logAudit } from '../audit/log';
import { sendEvictionNotice } from '../auth/mail';
import { loadTenant } from '../tenancy/load';
import { removeAuthRecord, removeHostedRecords } from './remove';
import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';

export type VerifiedVia = 'selfhost' | 'cloudflare' | 'txt' | 'parent' | 'existing';

/** Most unproven claims one workspace may hold at a time. */
export const MAX_PENDING_CLAIMS = 25;

export const CLAIM_TXT_LABEL = '_inboxangel';
export const CLAIM_TXT_PREFIX = 'inboxangel-verify=';

export type Admission =
  | { kind: 'verified'; via: VerifiedVia }
  | { kind: 'pending'; claim: DomainClaimRow }
  /** Another workspace already owns this domain. */
  | { kind: 'taken' }
  | { kind: 'limit' };

export interface ClaimView {
  id: number;
  domain: string;
  status: 'pending' | 'lost';
  txt_name: string;
  txt_value: string;
  created_at: number;
  last_checked_at: number | null;
  last_error: string | null;
}

export const claimTxtName = (domain: string): string => `${CLAIM_TXT_LABEL}.${domain}`;

export function claimView(c: DomainClaimRow): ClaimView {
  return {
    id: c.id,
    domain: c.domain,
    status: c.status === 'lost' ? 'lost' : 'pending',
    txt_name: claimTxtName(c.domain),
    txt_value: CLAIM_TXT_PREFIX + c.token,
    created_at: c.created_at,
    last_checked_at: c.last_checked_at,
    last_error: c.last_error,
  };
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

const within = (domain: string, zone: string): boolean => domain === zone || domain.endsWith(`.${zone}`);

/** Does an active Cloudflare connection of this workspace have the domain's zone on its allow-list? */
export async function provenByCloudflare(tenant: TenantContext, domain: string): Promise<boolean> {
  const q = tenant.scope.connections;
  for (const c of await q.list()) {
    if (c.status !== 'active') continue;
    const zones = (await q.zones(c.id)).filter(z => within(domain, z.zone_name.toLowerCase()));
    if (zones.length === 0) continue;
    // A child zone that exists but is not allowed serves this name: the parent's zone says nothing about it.
    const blocked = (await q.blockedZones(c.id)).map(z => z.zone_name.toLowerCase());
    if (blocked.some(b => within(domain, b))) continue;
    // The stored allow-list can be stale (zone moved away, expired): ask Cloudflare now, through the connection.
    for (const zone of zones) {
      try {
        const live = await (await tenant.connections.clientFor(c.id)).getZone(zone.zone_id) as { name?: string; status?: string };
        if (live.status === 'active' && live.name?.toLowerCase() === zone.zone_name.toLowerCase()) return true;
      } catch { /* unreachable or refused: not proven */ }
    }
  }
  return false;
}

async function provenByParent(tenant: TenantContext, domain: string): Promise<boolean> {
  const labels = domain.split('.');
  for (let i = 1; i <= labels.length - 2; i++) {
    const parent = await tenant.scope.domains.getByName(labels.slice(i).join('.'));
    if (parent && parent.verified_via !== 'legacy') return true; // a legacy row was never proven, so it proves nothing about its subdomains
  }
  return false;
}

/** Is the claim's token published at `_inboxangel.<domain>`? Throws nothing: a lookup failure is reported as the reason. */
export async function provenByTxt(claim: DomainClaimRow, resolver: Resolver): Promise<{ ok: boolean; reason?: string }> {
  const res = await resolver.txt(claimTxtName(claim.domain));
  if (res.status === 'error') return { ok: false, reason: `DNS lookup failed (${res.error ?? 'error'}) — try again in a minute` };
  const want = CLAIM_TXT_PREFIX + claim.token;
  const found = res.records.some(r => r.trim().replace(/^"|"$/g, '').trim() === want);
  return found ? { ok: true } : { ok: false, reason: `TXT record ${claimTxtName(claim.domain)} = "${want}" not found yet (DNS changes can take a few minutes)` };
}

/** How long an evicted workspace can still export the report history of the domain it lost. */
export const EVICTED_KEEP_DAYS = 30;

/**
 * Proof established: an unproven (legacy) holder of the name in another workspace loses it. That goes through the normal
 * removal path (hosted records and their quota, the authorisation record), then the domain is detached rather than
 * deleted: its reports stay for 30 days for export and the retention job purges them. The workspace's owners are emailed and the
 * eviction is audit-logged in their workspace.
 */
async function evictLegacyHolder(tenant: TenantContext, domain: string, via: VerifiedVia): Promise<void> {
  const lookups = claimLookups(tenant.db);
  const holder = await lookups.findLegacyHolder(domain, tenant.workspaceId);
  if (!holder) return;
  const evicted = await loadTenant(tenant.env, { workspaceId: holder.workspaceId });
  const root = await evicted.scope.domains.getById(holder.domainId);

  // The domain and everything below it that this workspace had under it (its subdomains hang off it by parent_id):
  // deepest first, so no live child is left pointing at a detached parent.
  const tree: Array<NonNullable<typeof root>> = [];
  const walk = async (row: NonNullable<typeof root>) => {
    for (const child of await evicted.scope.domains.subdomains(row.id)) await walk(child);
    tree.push(row);
  };
  if (root) await walk(root);

  for (const row of tree) {
    let cleanup: 'removed' | 'none' | 'failed' = 'none';
    try {
      if (await removeHostedRecords(evicted, row)) cleanup = 'removed';
    } catch (e) {
      // The rightful owner must not stay blocked by a Cloudflare outage: carry on, and say so in the audit entry. The
      // hosted cron's diff flags any record left behind.
      cleanup = 'failed';
      console.warn(`[eviction] hosted cleanup failed for domain ${row.id}:`, e instanceof Error ? e.message : e);
    }
    await removeAuthRecord(evicted, row);
    await lookups.detach(row.id, Math.floor(Date.now() / 1000));
    logAudit({ db: tenant.db, workspaceId: holder.workspaceId }, {
      actor_type: 'system', action: 'domain.evicted', resource_type: 'domain', resource_id: String(row.id), resource_name: row.domain,
      meta: { reason: row.id === holder.domainId ? 'another workspace proved ownership' : `subdomain of ${domain}, evicted with it`, via, hosted_cleanup: cleanup, history_kept_days: EVICTED_KEEP_DAYS },
    });
  }
  if (!root) await lookups.detach(holder.domainId, Math.floor(Date.now() / 1000));
  const owners = (await evicted.scope.team.list()).filter(m => m.role === 'owner').map(m => m.email);
  await sendEvictionNotice(tenant.env, owners, domain, EVICTED_KEEP_DAYS);
}

/**
 * Decide what happens when this workspace asks to monitor `domain` (already validated and lowercased).
 * Creates the pending claim when proof is needed; never inserts into `domains` (the caller does, on 'verified').
 */
export async function admitDomain(tenant: TenantContext, domain: string): Promise<Admission> {
  if (getMode(tenant.env) !== 'saas') return { kind: 'verified', via: 'selfhost' };
  if (await tenant.scope.domains.getByName(domain)) return { kind: 'verified', via: 'existing' }; // already ours: the insert reports the duplicate

  if (await claimLookups(tenant.db).ownedByOther(domain, tenant.workspaceId)) return { kind: 'taken' };
  if (await provenByParent(tenant, domain)) { await evictLegacyHolder(tenant, domain, 'parent'); return { kind: 'verified', via: 'parent' }; }
  if (await provenByCloudflare(tenant, domain)) { await evictLegacyHolder(tenant, domain, 'cloudflare'); return { kind: 'verified', via: 'cloudflare' }; }

  const existing = await tenant.scope.claims.get(domain);
  if (existing) {
    if (existing.status === 'lost') await tenant.scope.claims.delete(existing.id); // the other workspace may have since let go: start again
    else return { kind: 'pending', claim: existing };
  }
  if ((await tenant.scope.claims.count()) >= MAX_PENDING_CLAIMS) return { kind: 'limit' };
  return { kind: 'pending', claim: await tenant.scope.claims.upsert(domain, newToken()) };
}

export type VerifyOutcome =
  | { kind: 'verified'; via: VerifiedVia }
  | { kind: 'taken' }
  | { kind: 'unproven'; reason: string };

/** The "Verify" button: re-check every kind of proof for a pending claim. */
export async function verifyClaim(tenant: TenantContext, claim: DomainClaimRow, resolver: Resolver = createResolver()): Promise<VerifyOutcome> {
  if (await claimLookups(tenant.db).ownedByOther(claim.domain, tenant.workspaceId)) {
    await tenant.scope.claims.markLost(claim.id);
    return { kind: 'taken' };
  }
  if (await provenByParent(tenant, claim.domain)) { await evictLegacyHolder(tenant, claim.domain, 'parent'); return { kind: 'verified', via: 'parent' }; }
  if (await provenByCloudflare(tenant, claim.domain)) { await evictLegacyHolder(tenant, claim.domain, 'cloudflare'); return { kind: 'verified', via: 'cloudflare' }; }
  const txt = await provenByTxt(claim, resolver);
  await tenant.scope.claims.recordCheck(claim.id, txt.ok ? null : (txt.reason ?? null));
  if (txt.ok) await evictLegacyHolder(tenant, claim.domain, 'txt');
  return txt.ok ? { kind: 'verified', via: 'txt' } : { kind: 'unproven', reason: txt.reason ?? 'not verified' };
}

/** After a successful insert into `domains`: drop our claim and tell everyone else's they lost. */
export async function settleClaims(tenant: TenantContext, domain: string): Promise<void> {
  await tenant.scope.claims.deleteByDomain(domain);
  await claimLookups(tenant.db).markLost(domain, tenant.workspaceId);
}

/** The workspace's claims for display, with any that another workspace has since won marked lost. */
export async function listClaims(tenant: TenantContext): Promise<ClaimView[]> {
  const out: ClaimView[] = [];
  for (const c of await tenant.scope.claims.list()) {
    const lost = c.status === 'lost' || (await claimLookups(tenant.db).ownedByOther(c.domain, tenant.workspaceId));
    out.push(claimView(lost ? { ...c, status: 'lost' } : c));
  }
  return out;
}

export { normalizeName };
