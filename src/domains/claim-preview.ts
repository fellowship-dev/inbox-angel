// Read-only live DNS preview for a domain the workspace has claimed but not yet proven.
//
// It looks up public DNS only (SPF, DMARC, a scan of common DKIM selectors, MX), through one resolver, and returns a small view.
// Nothing is stored and nothing of the workspace or the claim goes in: public DNS may be shown before ownership is proven, and the
// answers are cached per domain (shared across workspaces) for a minute. A lookup that failed is `error`, never "missing".
import { COMMON_DKIM_SELECTORS, SPF_LOOKUP_LIMIT, createResolver, lookupDmarc, lookupMx, normalizeName, scanDkimSelectors, type Resolver, type TxtResult } from '@ready-set-mail/dns-checks';
import { claimLookups, type DomainClaimRow } from '@ready-set-mail/db';
import { dmarcFactsFromLookup, observingResolver, snapshotDns } from '../email/dns-snapshot';
import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';

export interface ClaimPreview {
  domain: string;
  checked_at: string;
  source: 'public_dns';
  cached: boolean;
  /** DNS says the domain itself does not exist (as opposed to existing with no record). */
  nxdomain: boolean;
  /** `error`: the lookup failed, so nothing is known. `missing`: DNS answered that there is no record. */
  spf: { status: 'found' | 'missing' | 'error'; record: string | null; lookup_count: number | null; over_limit: boolean };
  /** The policy that applies to the domain (inherited from the organizational domain when it has no record of its own); `issue`: a record exists but gives no policy. */
  dmarc: { status: 'found' | 'missing' | 'error'; policy: string | null; issue: 'multiple' | 'invalid' | null; inherited_from: string | null; record: string | null; /** pct= of the record that applies (100 when absent); null without a usable record. */ pct: number | null };
  /** `not_found` means none of the `scanned` common selectors: not that the domain has no DKIM. `wildcard`: every name answered with the same TXT record, so nothing can be said about which selectors exist. */
  dkim: { status: 'found' | 'not_found' | 'wildcard' | 'error'; selectors: string[]; scanned: number; failed: number };
  mx: { status: 'found' | 'none' | 'error' };
  /** The checks whose lookup errored. */
  lookup_failed: Array<'spf' | 'dmarc' | 'dkim' | 'mx'>;
}

export const PREVIEW_TTL_MS = 60_000;
export const PREVIEW_CACHE_MAX = 500;
export const PREVIEW_LIMIT = 10;
export const PREVIEW_WINDOW_MS = 60_000;

/**
 * In-isolate state, deliberately shared by every request this isolate serves: public DNS carries nothing of any workspace, so the
 * 60 s answers may be reused across workspaces, and the limiter's fallback window is per person. Held in one instance (not bare
 * module-level maps) so the tenancy guard for per-tenant module state stays meaningful.
 */
class PreviewState {
  readonly cache = new Map<string, { at: number; view: ClaimPreview }>();
  readonly windows = new Map<string, { start: number; count: number }>();
  /** The missing-limiter warning has been logged by this isolate. */
  warnedNoLimiter = false;
}
const state = new PreviewState();
const { cache, windows } = state;

export function __resetPreviewCacheForTests(): void {
  state.cache.clear();
  state.windows.clear();
  state.warnedNoLimiter = false;
}

/** Which limiter answers: the Workers ratelimit binding, or this isolate's own counter (which a hosted instance should not rely on). */
export const dnsPreviewLimiter = (env: Pick<TenantContext['env'], 'DNS_PREVIEW_LIMITER'>): 'binding' | 'fallback' => (env.DNS_PREVIEW_LIMITER ? 'binding' : 'fallback');

const NO_LIMITER_WARNING = '[claim-preview] DNS_PREVIEW_LIMITER binding missing: falling back to a per-isolate counter; add the ratelimit binding for hosted mode.';

/** Is a fresh answer for this domain cached? Such a request costs no DNS, so it does not count against the limit. */
export function hasFreshPreview(domain: string, now = Date.now()): boolean {
  const hit = cache.get(normalizeName(domain));
  return !!hit && now - hit.at < PREVIEW_TTL_MS;
}

/** The cached view of this domain when it is still fresh (no DNS), else null: lets the moment of proof reuse what the preview read. */
export function cachedPreview(domain: string, now = Date.now()): ClaimPreview | null {
  const hit = cache.get(normalizeName(domain));
  return hit && now - hit.at < PREVIEW_TTL_MS ? hit.view : null;
}

/** Same lookups as the dashboard's checks; never throws: a lookup that throws is an error. */
async function settle<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch { return null; }
}

/** Remembers each TXT answer, so the DMARC record text can be read after the snapshot without a second subrequest. */
function memoTxt(base: Resolver): Resolver {
  const seen = new Map<string, Promise<TxtResult>>();
  return { ...base, txt: name => { const k = name.toLowerCase(); if (!seen.has(k)) seen.set(k, base.txt(name)); return seen.get(k)!; } };
}

async function lookup(domain: string, base: Resolver, checkedAt: string): Promise<ClaimPreview> {
  const memo = memoTxt(base);
  // SPF and DMARC come from the same code the daily refresh stores (src/email/dns-snapshot.ts), so this view and the overview card agree.
  const [snap, dkimS, mxL] = await Promise.all([
    settle(() => snapshotDns(domain, memo)),
    settle(() => scanDkimSelectors(base, domain, COMMON_DKIM_SELECTORS)),
    settle(() => lookupMx(base, domain)),
  ]);

  const spfRecord = snap?.spf_record;
  const count = snap?.spf_lookup_count ?? null;
  const spf: ClaimPreview['spf'] = {
    status: spfRecord === undefined ? 'error' : spfRecord === null ? 'missing' : 'found',
    record: spfRecord ?? null,
    lookup_count: count,
    over_limit: count !== null && count > SPF_LOOKUP_LIMIT,
  };

  const facts = snap?.dmarc;
  // The record text only: same answers as the snapshot (memoised), interpreted by the same dmarcFactsFromLookup.
  const rawLookup = facts && (facts.policy || facts.issue) ? await settle(() => lookupDmarc(observingResolver(memo, domain), domain)) : null;
  const dmarc: ClaimPreview['dmarc'] = {
    status: !facts ? 'error' : facts.policy || facts.issue ? 'found' : 'missing',
    policy: facts?.policy ?? null,
    issue: facts?.issue ?? null,
    inherited_from: facts?.inherited_from ?? null,
    record: rawLookup && dmarcFactsFromLookup(rawLookup) ? (rawLookup.record?.raw ?? rawLookup.rawRecords?.join(' | ') ?? null) : null,
    pct: facts?.pct ?? null,
  };

  let dkim: ClaimPreview['dkim'] = { status: 'error', selectors: [], scanned: 0, failed: 0 };
  if (dkimS) {
    const selectors = dkimS.found.map(f => f.name);
    dkim = {
      status: dkimS.wildcard ? 'wildcard' : selectors.length > 0 ? 'found' : dkimS.errors.length === 0 ? 'not_found' : 'error',
      selectors, scanned: dkimS.scanned, failed: dkimS.errors.length,
    };
  }

  const mx: ClaimPreview['mx'] = { status: !mxL || mxL.status === 'error' ? 'error' : mxL.status === 'found' ? 'found' : 'none' };

  const lookup_failed = (['spf', 'dmarc', 'dkim', 'mx'] as const).filter(k => ({ spf, dmarc, dkim, mx })[k].status === 'error');
  return { domain, checked_at: checkedAt, source: 'public_dns', cached: false, nxdomain: snap?.nxdomain ?? false, spf, dmarc, dkim, mx, lookup_failed };
}

/** The public-DNS view of a domain, from the 60 s cache when fresh. Reads nothing stored; writes nothing. */
export async function previewClaimDns(domain: string, opts: { resolver?: Resolver; now?: number } = {}): Promise<ClaimPreview> {
  const name = normalizeName(domain);
  const now = opts.now ?? Date.now();
  const hit = cache.get(name);
  if (hit && now - hit.at < PREVIEW_TTL_MS) return { ...hit.view, cached: true };

  const view = await lookup(name, opts.resolver ?? createResolver(), new Date(now).toISOString());
  cache.delete(name);
  cache.set(name, { at: now, view });
  while (cache.size > PREVIEW_CACHE_MAX) cache.delete(cache.keys().next().value as string); // oldest first
  return view;
}

/** Fixed-window counter for deployments without the DNS_PREVIEW_LIMITER binding (tests, self-hosters). Per isolate. */
function windowAllows(key: string, now: number): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= PREVIEW_WINDOW_MS) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= PREVIEW_WINDOW_MS) windows.delete(k);
    return true;
  }
  if (w.count >= PREVIEW_LIMIT) return false;
  w.count++;
  return true;
}

/** Who is rate limited: the signed-in person, else the workspace. (API keys resolve to their owner, so they share that user's allowance.) */
export const previewLimitKey = (who: { userId?: string; workspaceId: string }): string => (who.userId ? `user:${who.userId}` : `ws:${who.workspaceId}`);

const json = (data: unknown, status = 200, headers?: Record<string, string>) => Response.json(data, { status, headers });

/** The route's work after the claim is loaded (workspace-scoped, so another workspace's id never gets here). */
export async function claimPreviewResponse(tenant: TenantContext, claim: DomainClaimRow, who: { userId?: string }): Promise<Response> {
  if (claim.status === 'lost' || (await claimLookups(tenant.db).ownedByOther(claim.domain, tenant.workspaceId))) {
    return json({ error: 'another workspace has already verified this domain', code: 'claim_lost' }, 409);
  }
  const now = Date.now();
  // Only a cache miss runs DNS, so only a miss counts.
  if (!hasFreshPreview(claim.domain, now)) {
    const key = previewLimitKey({ userId: who.userId, workspaceId: tenant.workspaceId });
    if (!tenant.env.DNS_PREVIEW_LIMITER && getMode(tenant.env) === 'saas' && !state.warnedNoLimiter) {
      state.warnedNoLimiter = true;
      console.warn(NO_LIMITER_WARNING);
    }
    const allowed = tenant.env.DNS_PREVIEW_LIMITER ? (await tenant.env.DNS_PREVIEW_LIMITER.limit({ key })).success : windowAllows(key, now);
    if (!allowed) return json({ error: 'Checked too often. Try again in a minute.', code: 'rate_limited', retry_after: 60 }, 429, { 'Retry-After': '60' });
  }
  return json(await previewClaimDns(claim.domain, { now }));
}
