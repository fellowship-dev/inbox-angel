// The first stored DNS read of a domain that has just been proven (a hosted claim becoming a domain).
//
// Without it the overview says "Level 0 · not checked yet" right after the claim's public DNS preview showed the real level,
// until the domain page is opened or the daily job runs. So at the moment of proof, store what DNS says: the preview's own
// answer when this isolate read it in the last minute, else one snapshot, the same `snapshotDns` the daily refresh runs.
// The write goes through `recordDnsCheck`, so "no record" is stored only when DNS answered so. A read in which SPF or DMARC
// got no answer stores nothing (the card keeps saying "not checked yet", never "missing"). It never fails the proof.
import type { Resolver } from '@ready-set-mail/dns-checks';
import { snapshotDns, type DnsSnapshot } from '../email/dns-snapshot';
import type { TenantContext } from '../tenancy/context';
import { cachedPreview, type ClaimPreview } from './claim-preview';
import type { VerifiedVia } from './ownership';

/** The proofs that turn a hosted claim into a domain. */
const CLAIM_PROOFS: ReadonlySet<VerifiedVia> = new Set(['txt', 'cloudflare', 'parent']);
export const isClaimProof = (via: VerifiedVia): boolean => CLAIM_PROOFS.has(via);

/** The preview's SPF/DMARC facts in the snapshot's shape: `error` becomes "unknown" (left out), never "missing". */
export function snapshotFromPreview(p: ClaimPreview): DnsSnapshot {
  const out: DnsSnapshot = { nxdomain: p.nxdomain };
  if (p.spf.status !== 'error') {
    out.spf_record = p.spf.status === 'found' ? p.spf.record : null;
    if (p.spf.lookup_count !== null) out.spf_lookup_count = p.spf.lookup_count;
  }
  if (p.dmarc.status !== 'error') out.dmarc = { policy: p.dmarc.policy, issue: p.dmarc.issue, inherited_from: p.dmarc.inherited_from, pct: p.dmarc.pct };
  return out;
}

/**
 * Store the first DNS read of `domainId`. Costs at most one snapshot (none when the preview is fresh). Returns where the
 * facts came from, or null when nothing could be stored.
 */
export async function recordFirstDnsCheck(
  tenant: TenantContext, domainId: number, domain: string, opts: { resolver?: Resolver; now?: number } = {},
): Promise<'preview' | 'snapshot' | null> {
  try {
    const fresh = cachedPreview(domain, opts.now);
    const found = fresh ? snapshotFromPreview(fresh) : await snapshotDns(domain, opts.resolver);
    if (found.spf_lookup_count !== undefined) await tenant.scope.domains.updateSpfLookupCount(domainId, found.spf_lookup_count);
    // Only a complete read is stored: a half-answered one would turn "not checked yet" into "last check failed" on a domain
    // proven seconds ago. The daily refresh and the domain page read it again either way.
    if (found.spf_record === undefined || found.dmarc === undefined) return null;
    await tenant.scope.domains.recordDnsCheck(domainId, { spf_record: found.spf_record, dmarc: found.dmarc, nxdomain: found.nxdomain, at: Math.floor((opts.now ?? Date.now()) / 1000) });
    return fresh ? 'preview' : 'snapshot';
  } catch (e) {
    console.warn(`[domain.verified] first DNS check not stored for ${domain}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Re-check at most every 5 minutes per domain, however often it is viewed. */
const RECHECK_AFTER_SECONDS = 300;

/**
 * A domain whose last good check stored an enforcing policy but no pct= (every read since pct= is recorded stores a number):
 * its level stands, marked "not re-checked yet", and viewing it starts one refresh, the daily job's snapshot and store.
 */
export function needsPctRecheck(s: { dmarc_policy: string | null; dmarc_pct: number | null; dns_checked_at: number | null; dns_check_attempted_at: number | null }, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const enforcing = s.dmarc_policy === 'quarantine' || s.dmarc_policy === 'reject';
  return enforcing && s.dmarc_pct === null && s.dns_checked_at !== null && nowSeconds - (s.dns_check_attempted_at ?? 0) >= RECHECK_AFTER_SECONDS;
}

/** The daily job's refresh for one domain (src/cron.ts): one snapshot, stored with recordDnsCheck's rules (a failure keeps the stored values). */
export async function recheckStoredDns(tenant: TenantContext, domainId: number, domain: string, resolver?: Resolver): Promise<void> {
  try {
    const found = await snapshotDns(domain, resolver);
    if (found.spf_lookup_count !== undefined) await tenant.scope.domains.updateSpfLookupCount(domainId, found.spf_lookup_count);
    await tenant.scope.domains.recordDnsCheck(domainId, { spf_record: found.spf_record, dmarc: found.dmarc, nxdomain: found.nxdomain, at: Math.floor(Date.now() / 1000) });
  } catch (e) {
    console.warn(`[dns.recheck] not stored for ${domain}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Claim the one pct= refresh for this domain: an atomic conditional write of the attempt time, so of several views at once
 * exactly one runs the snapshot (the others see the fresh attempt time). True when this caller won.
 */
export async function reservePctRecheck(tenant: TenantContext, domainId: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const r = await (tenant.env.DB as D1Database).prepare(
    "UPDATE domains SET dns_check_attempted_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND dmarc_pct IS NULL AND dmarc_policy IN ('quarantine', 'reject') AND (dns_check_attempted_at IS NULL OR dns_check_attempted_at <= ?4)",
  ).bind(nowSeconds, domainId, tenant.workspaceId, nowSeconds - RECHECK_AFTER_SECONDS).run();
  return (r.meta.changes ?? 0) === 1;
}
