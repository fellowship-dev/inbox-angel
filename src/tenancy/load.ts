// Builds a TenantContext: reads the tenant's settings from D1 and fills in what is
// missing from the Cloudflare API (zone of the base domain, Cloudflare account id). Resolved values are persisted so later requests skip the API.
//
// This replaces the module-level caches that used to live in env-utils.ts.

import type { BoundEnv } from '../index';
import { DEFAULT_BRAND_COLOR, TenantContext, type TenantSettings } from './context';
import { CfConnectionError, CfError, CfNotConfiguredError } from './cf-client';
import { getMode, type Mode } from './mode';
import type { ResolvedAccount } from './resolver';

const KEYS: readonly string[] = [
  'base_domain', 'zone_id', 'zone_name', 'account_id', 'reports_domain', 'from_email', 'workers_subdomain',
  'brand_logo_url', 'brand_color',
];

/** The tenant's Cloudflare token. Self-host: the Worker secret. Saas: per-account credentials (none stored yet). */
function cfTokenFor(env: BoundEnv, mode: Mode): string | undefined {
  return mode === 'selfhost' ? env.CLOUDFLARE_API_TOKEN || undefined : undefined;
}

export interface LoadOptions {
  /** The tenant's Cloudflare token, overriding the default for the mode (per-account credentials). */
  cfToken?: string;
  /** Injected Cloudflare transport (tests). */
  fetch?: typeof fetch;
}

export async function loadTenant(env: BoundEnv, account: ResolvedAccount, opts: LoadOptions = {}): Promise<TenantContext> {
  const mode = getMode(env);
  const tenant = new TenantContext({
    env,
    accountId: account.accountId,
    userId: account.userId,
    role: account.role,
    mode,
    cfToken: opts.cfToken ?? cfTokenFor(env, mode),
    fetch: opts.fetch,
  });
  await refreshTenant(tenant);
  return tenant;
}

/** Re-read settings (after the wizard changed them) and re-resolve whatever is missing. */
export async function refreshTenant(tenant: TenantContext): Promise<void> {
  tenant.invalidate();
  const q = tenant.scope;
  const raw = await q.settings.getMany([...KEYS]);
  // Any connection, broken ones included: using a broken one must fail with its own error, not look unconfigured.
  tenant.setHasConnections((await q.connections.list()).length > 0);
  // An empty value means "cleared" (the wizard blanks the zone when the base domain changes).
  const stored = { get: (key: string) => raw.get(key) || undefined };
  const s: TenantSettings = {
    baseDomain: stored.get('base_domain'),
    zoneId: stored.get('zone_id'),
    zoneName: stored.get('zone_name'),
    cfAccountId: stored.get('account_id'),
    reportsDomain: stored.get('reports_domain'),
    fromEmail: stored.get('from_email'),
    workersSubdomain: stored.get('workers_subdomain'),
    brandLogoUrl: stored.get('brand_logo_url'),
    brandColor: stored.get('brand_color') ?? DEFAULT_BRAND_COLOR,
  };

  // Multi-domain installs keep the hub domain on the domains table, not in settings.
  if (!s.baseDomain) s.baseDomain = (await q.domains.getDefault())?.domain;

  tenant.settings = s;
  const persist: Record<string, string> = {};
  const cf = tenant.cf();

  // Zone + Cloudflare account of the base domain (through the connection the domain is linked to, if any).
  try {
    if (s.baseDomain && (!s.zoneId || !s.cfAccountId) && tenant.hasCloudflare()) {
      const zone = await (await tenant.cfFor(s.baseDomain)).zoneFor(s.baseDomain);
      s.zoneId = zone.id; s.zoneName = zone.name; s.cfAccountId = zone.accountId ?? s.cfAccountId;
      persist.zone_id = zone.id; persist.zone_name = zone.name;
      if (zone.accountId) persist.account_id = zone.accountId;
    } else if (cf && s.zoneId && !s.zoneName) {
      // Installs that stored a zone id before zone names were kept.
      const zone = await cf.getZone(s.zoneId);
      s.zoneName = zone.name.toLowerCase(); persist.zone_name = s.zoneName;
    }
  } catch (e) {
    // Best effort, as before: a Cloudflare outage or a token without Zone:Read must not take
    // the dashboard down. Features that need the zone resolve it again and report the error.
    // (A domain not linked to any connection yet is not worth a log line per request.)
    if (!(e instanceof CfNotConfiguredError)) {
      console.warn(`[tenant ${tenant.accountId}] Cloudflare lookup failed:`, e instanceof CfError || e instanceof CfConnectionError ? e.message : e instanceof Error ? e.name : 'error');
    }
  }

  if (!s.reportsDomain && s.baseDomain) s.reportsDomain = `reports.${s.baseDomain}`;
  if (!s.fromEmail && s.baseDomain) s.fromEmail = `noreply@reports.${s.baseDomain}`;

  tenant.invalidate(); // a zone resolved above must be seeded into a fresh client
  if (Object.keys(persist).length) {
    await q.settings.setMany(persist).catch(() => {});
  }
}
