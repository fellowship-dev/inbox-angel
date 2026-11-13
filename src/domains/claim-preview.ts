// Read-only live DNS preview for a domain the workspace has claimed but not yet proven.
//
// It looks up public DNS only (SPF, DMARC, a scan of common DKIM selectors, MX), through one resolver, and returns a small view.
// Nothing is stored and nothing of the workspace or the claim goes in: public DNS may be shown before ownership is proven, and the
// answers are cached per domain (shared across workspaces) for a minute. A lookup that failed is `error`, never "missing".
import { COMMON_DKIM_SELECTORS, analyzeSpf, createResolver, lookupDmarc, lookupMx, normalizeName, scanDkimSelectors, type Resolver, type SpfAnalysis } from '@inbox-angel/dns-checks';
import { claimLookups, type DomainClaimRow } from '@inbox-angel/db';
import type { TenantContext } from '../tenancy/context';

export interface ClaimPreview {
  domain: string;
  checked_at: string;
  source: 'public_dns';
  cached: boolean;
  spf: { status: 'found' | 'missing' | 'invalid' | 'error'; record: string | null; lookup_count: number | null; over_limit: boolean; issues: string[] };
  dmarc: { status: 'found' | 'missing' | 'invalid' | 'multiple' | 'error'; record: string | null; policy: string | null; inherited: boolean; found_at: string | null };
  /** `not_found` means none of the `scanned` common selectors: not that the domain has no DKIM. */
  dkim: { status: 'found' | 'not_found' | 'error'; selectors: string[]; scanned: number; failed: number };
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
}
const state = new PreviewState();
const { cache, windows } = state;

export function __resetPreviewCacheForTests(): void {
  state.cache.clear();
  state.windows.clear();
}

/** Is a fresh answer for this domain cached? Such a request costs no DNS, so it does not count against the limit. */
export function hasFreshPreview(domain: string, now = Date.now()): boolean {
  const hit = cache.get(normalizeName(domain));
  return !!hit && now - hit.at < PREVIEW_TTL_MS;
}

const FATAL_BESIDES_LIMIT: ReadonlySet<string> = new Set(['multiple-records', 'void-lookup-limit', 'mx-name-limit', 'loop', 'include-no-record', 'redirect-no-record', 'depth-limit', 'syntax']);

export function mapSpf(a: SpfAnalysis): ClaimPreview['spf'] {
  const issues = a.issues.map(i => i.message);
  const record = a.record?.raw ?? null;
  const base = { record, lookup_count: a.record ? a.lookupCount : null, over_limit: false, issues };
  if (a.status === 'temperror') return { ...base, status: 'error' };
  if (a.status === 'none') return { ...base, status: 'missing', lookup_count: null };
  if (a.status === 'ok') return { ...base, status: 'found' };
  // permerror: a record over the 10-lookup limit is published and parses; anything else (several records, a syntax error, a loop…) is broken.
  const onlyLimit = a.record && a.lookupLimitExceeded && !a.issues.some(i => FATAL_BESIDES_LIMIT.has(i.code));
  return onlyLimit ? { ...base, status: 'found', over_limit: true } : { ...base, status: 'invalid', record: a.rawRecords ? null : record };
}

/** Same lookups as the dashboard's checks; never throws: a lookup that throws is an error. */
async function settle<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch { return null; }
}

async function lookup(domain: string, resolver: Resolver, checkedAt: string): Promise<ClaimPreview> {
  const [spfA, dmarcL, dkimS, mxL] = await Promise.all([
    settle(() => analyzeSpf(domain, resolver)),
    settle(() => lookupDmarc(resolver, domain)),
    settle(() => scanDkimSelectors(resolver, domain, COMMON_DKIM_SELECTORS)),
    settle(() => lookupMx(resolver, domain)),
  ]);

  const spf: ClaimPreview['spf'] = spfA ? mapSpf(spfA) : { status: 'error', record: null, lookup_count: null, over_limit: false, issues: [] };

  let dmarc: ClaimPreview['dmarc'] = { status: 'error', record: null, policy: null, inherited: false, found_at: null };
  if (dmarcL) {
    const at = { inherited: dmarcL.inherited, found_at: dmarcL.foundAt };
    if (dmarcL.status === 'found' && dmarcL.record) {
      dmarc = dmarcL.record.valid
        ? { status: 'found', record: dmarcL.record.raw, policy: dmarcL.record.policy, ...at }
        : { status: 'invalid', record: dmarcL.record.raw, policy: null, ...at };
    } else if (dmarcL.status === 'multiple') dmarc = { status: 'multiple', record: null, policy: null, ...at };
    else if (dmarcL.status === 'none') dmarc = { status: 'missing', record: null, policy: null, inherited: false, found_at: null };
  }

  let dkim: ClaimPreview['dkim'] = { status: 'error', selectors: [], scanned: 0, failed: 0 };
  if (dkimS) {
    const selectors = dkimS.found.map(f => f.name);
    dkim = {
      status: selectors.length > 0 ? 'found' : dkimS.errors.length === 0 ? 'not_found' : 'error',
      selectors, scanned: dkimS.scanned, failed: dkimS.errors.length,
    };
  }

  const mx: ClaimPreview['mx'] = { status: !mxL || mxL.status === 'error' ? 'error' : mxL.status === 'found' ? 'found' : 'none' };

  const lookup_failed = (['spf', 'dmarc', 'dkim', 'mx'] as const).filter(k => ({ spf, dmarc, dkim, mx })[k].status === 'error');
  return { domain, checked_at: checkedAt, source: 'public_dns', cached: false, spf, dmarc, dkim, mx, lookup_failed };
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
    const allowed = tenant.env.DNS_PREVIEW_LIMITER ? (await tenant.env.DNS_PREVIEW_LIMITER.limit({ key })).success : windowAllows(key, now);
    if (!allowed) return json({ error: 'Checked too often. Try again in a minute.', code: 'rate_limited', retry_after: 60 }, 429, { 'Retry-After': '60' });
  }
  return json(await previewClaimDns(claim.domain, { now }));
}
