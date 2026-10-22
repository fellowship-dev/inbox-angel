import { Env } from './index';
import { scope } from './db/scope';

// Module-level cache — lives for the lifetime of the Worker instance (reused across requests)
let _enrichedOnce = false;
let _zoneIdCache: string | undefined;
let _accountIdCache: string | undefined;
let _baseDomainCache: string | undefined;
let _reportsDomainCache: string | undefined;
let _fromEmailCache: string | undefined;
let _workersSubdomainCache: string | undefined;
let _brandLogoUrlCache: string | undefined;
let _brandColorCache: string | undefined;

/** Return the cached reports domain (e.g. "reports.yourdomain.com"). */
export function reportsDomain(): string | undefined {
  return _reportsDomainCache;
}

/** Return the cached from email (e.g. "noreply@reports.yourdomain.com"). */
export function fromEmail(): string | undefined {
  return _fromEmailCache;
}

/** Return the cached zone ID (set by resolveZoneId / enrichEnv). */
export function getZoneId(): string | undefined {
  return _zoneIdCache;
}

/** Return the cached account ID (set by resolveZoneId / enrichEnv). */
export function getAccountId(): string | undefined {
  return _accountIdCache;
}

/** Return the cached base domain (set by enrichEnv from D1). */
export function getBaseDomain(): string | undefined {
  return _baseDomainCache;
}

/** Return the cached workers subdomain (e.g. "fellowshipdev"). */
export function getWorkersSubdomain(): string | undefined {
  return _workersSubdomainCache;
}

/** Return the configured brand logo URL (optional, for HTML emails). */
export function brandLogoUrl(): string | undefined {
  return _brandLogoUrlCache;
}

/** Return the configured brand accent color (hex, e.g. "#4F46E5"). */
export function brandColor(): string {
  return _brandColorCache ?? '#4F46E5';
}

/**
 * Resolve the Cloudflare zone ID via CF API.
 * Also caches account ID from the same response.
 * Result is cached in-process — only one API call per cold start.
 *
 * CF zones are apex-only. If the lookup returns empty (e.g. base_domain is
 * a subdomain like "marketing.acme.com"), we strip one label and retry once
 * with the apex domain ("acme.com").
 */
async function resolveZoneId(apiToken: string): Promise<string | undefined> {
  if (_zoneIdCache) return _zoneIdCache;
  if (!_baseDomainCache) return undefined;

  const lookup = async (name: string) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    return res.json() as Promise<{ result?: { id: string; account: { id: string } }[] }>;
  };

  try {
    let data = await lookup(_baseDomainCache);
    if (!data.result?.length) {
      // Retry with apex label (strip one subdomain label)
      const parts = _baseDomainCache.split('.');
      if (parts.length > 2) {
        data = await lookup(parts.slice(1).join('.'));
      }
    }
    _zoneIdCache = data.result?.[0]?.id;
    _accountIdCache = data.result?.[0]?.account?.id;
    return _zoneIdCache;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Cloudflare Workers subdomain via CF API.
 * GET /accounts/{account_id}/workers/subdomain → { subdomain: "fellowshipdev" }
 * Result is cached in-process + D1.
 */
async function resolveWorkersSubdomain(apiToken: string): Promise<string | undefined> {
  if (_workersSubdomainCache) return _workersSubdomainCache;
  if (!_accountIdCache) return undefined;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${_accountIdCache}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (!res.ok) return undefined;
    const data = await res.json() as { result?: { subdomain: string } };
    _workersSubdomainCache = data.result?.subdomain;
    return _workersSubdomainCache;
  } catch {
    return undefined;
  }
}

/**
 * Warm all caches from D1. Call once at the top of request/cron handlers.
 *
 * Resolution order:
 *   1. Module-level cache (hot path — no I/O)
 *   2. D1 settings table (persisted by wizard)
 *   3. Cloudflare API (zone_id + account_id only)
 *   4. Derived defaults (reports_domain, from_email)
 *
 * After resolution, zone_id and account_id are persisted to D1 so subsequent
 * cold starts skip the API call.
 */
export async function enrichEnv(env: Env, db?: D1Database): Promise<void> {
  const effectiveDb = db ?? env.DB;

  // 1. Load from D1 if we have a database and haven't loaded yet
  if (effectiveDb && !_enrichedOnce) {
    const settings = await scope(effectiveDb).settings.getMany([
      'base_domain', 'zone_id', 'account_id', 'reports_domain', 'from_email', 'workers_subdomain',
      'brand_logo_url', 'brand_color',
    ]);

    if (!_baseDomainCache) _baseDomainCache = settings.get('base_domain');
    if (!_zoneIdCache) _zoneIdCache = settings.get('zone_id');
    if (!_accountIdCache) _accountIdCache = settings.get('account_id');
    if (!_reportsDomainCache) _reportsDomainCache = settings.get('reports_domain');
    if (!_fromEmailCache) _fromEmailCache = settings.get('from_email');
    if (!_workersSubdomainCache) _workersSubdomainCache = settings.get('workers_subdomain');

    if (!_brandLogoUrlCache) _brandLogoUrlCache = settings.get('brand_logo_url');
    if (!_brandColorCache) _brandColorCache = settings.get('brand_color');

    // Fallback: derive base domain from domains.is_default=1 if not in settings.
    // This supports the multi-domain model where base_domain migrates out of settings.
    if (!_baseDomainCache) {
      const defaultDomain = await effectiveDb
        .prepare('SELECT domain FROM domains WHERE is_default = 1 LIMIT 1')
        .first<{ domain: string }>();
      if (defaultDomain) _baseDomainCache = defaultDomain.domain;
    }

    _enrichedOnce = true;
  }

  // 2. Resolve zone_id + account_id via API if still missing
  if ((!_zoneIdCache || !_accountIdCache) && _baseDomainCache && env.CLOUDFLARE_API_TOKEN) {
    await resolveZoneId(env.CLOUDFLARE_API_TOKEN);
  }

  // 2b. Resolve workers subdomain via API if still missing
  if (!_workersSubdomainCache && _accountIdCache && env.CLOUDFLARE_API_TOKEN) {
    await resolveWorkersSubdomain(env.CLOUDFLARE_API_TOKEN);
  }

  // 3. Derive defaults
  if (!_reportsDomainCache && _baseDomainCache) {
    _reportsDomainCache = `reports.${_baseDomainCache}`;
  }
  if (!_fromEmailCache && _baseDomainCache) {
    _fromEmailCache = `noreply@reports.${_baseDomainCache}`;
  }

  // 4. Persist resolved values to D1 (fire-and-forget, non-blocking)
  if (effectiveDb && _zoneIdCache && _accountIdCache) {
    const topersist: Record<string, string> = {
      zone_id: _zoneIdCache,
      account_id: _accountIdCache,
    };
    if (_workersSubdomainCache) topersist.workers_subdomain = _workersSubdomainCache;
    scope(effectiveDb).settings.setMany(topersist).catch(() => {});
  }
}

/**
 * Reset module-level caches. Call after wizard sets a new base_domain.
 */
export function resetEnvCache(): void {
  _zoneIdCache = undefined;
  _accountIdCache = undefined;
  _baseDomainCache = undefined;
  _reportsDomainCache = undefined;
  _fromEmailCache = undefined;
  _workersSubdomainCache = undefined;
  _brandLogoUrlCache = undefined;
  _brandColorCache = undefined;
}
