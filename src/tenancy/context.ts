// Everything one request (or one cron account) needs to know about its tenant.
//
// A TenantContext is built per request and thrown away with it: account-scoped
// queries, the tenant's settings (domains, branding, Cloudflare ids) and a
// Cloudflare client keyed by that tenant's token. There is no module-level
// per-tenant state anywhere in src/, so concurrent requests for different
// accounts in one isolate cannot see each other's data.

import type { BoundEnv } from '../index';
import { forAccount, type AccountScope } from '@inbox-angel/db';
import { CfClient, CfNotConfiguredError, CfZoneNotFoundError, zoneCandidates, type CfZone } from './cf-client';
import { ConnectionService } from '../connections/service';
import { logAudit } from '../audit/log';
import { notifyConnectionBroken } from '../monitor/notify';
import { getMode, type Mode } from './mode';
import type { ResolvedAccount } from './resolver';

/** Script name of existing installs; also the default for new ones. */
export const DEFAULT_WORKER_NAME = 'inbox-angel-worker';

export function workerName(env: { WORKER_NAME?: string }): string {
  return env.WORKER_NAME || DEFAULT_WORKER_NAME;
}

export const DEFAULT_BRAND_COLOR = '#4F46E5';

export interface TenantSettings {
  baseDomain?: string;
  /** Cloudflare zone of the base domain. */
  zoneId?: string;
  zoneName?: string;
  /** Cloudflare account id (not the tenant's accountId). */
  cfAccountId?: string;
  reportsDomain?: string;
  fromEmail?: string;
  workersSubdomain?: string;
  brandLogoUrl?: string;
  brandColor: string;
}

/** Branding applied to outbound HTML mail. */
export interface Brand { color: string; logoUrl?: string }

export interface TenantInit {
  env: BoundEnv;
  accountId: string;
  userId?: string;
  role?: string;
  mode?: Mode;
  settings?: Partial<TenantSettings>;
  /** The tenant's Cloudflare API token. Absent means "Cloudflare not configured". */
  cfToken?: string;
  /** Injected Cloudflare transport (tests); defaults to global fetch. */
  fetch?: typeof fetch;
}

export class TenantContext {
  readonly accountId: string;
  readonly userId?: string;
  readonly role?: string;
  readonly mode: Mode;
  readonly env: BoundEnv;
  readonly db: D1Database;
  /** Account-scoped queries: every tenant-data read and write goes through this. */
  readonly scope: AccountScope;
  settings: TenantSettings;

  readonly #cfToken?: string;
  readonly #fetch?: typeof fetch;
  #cf?: CfClient;
  #connections?: ConnectionService;
  /** domain name -> linked connection id (null: unlinked), read once per context. */
  #links?: Promise<Map<string, string | null>>;
  #hasConnections = false;
  #telemetry?: Promise<boolean>;

  constructor(init: TenantInit) {
    this.env = init.env;
    this.db = init.env.DB;
    this.accountId = init.accountId;
    this.userId = init.userId;
    this.role = init.role;
    this.mode = init.mode ?? getMode(init.env);
    this.settings = { brandColor: DEFAULT_BRAND_COLOR, ...init.settings };
    this.scope = forAccount(this.db, init.accountId);
    this.#cfToken = init.cfToken;
    this.#fetch = init.fetch;
  }

  get workerName(): string { return workerName(this.env); }

  get brand(): Brand { return { color: this.settings.brandColor, logoUrl: this.settings.brandLogoUrl }; }

  /** The Cloudflare client for this tenant, or null when no token is configured. */
  cf(): CfClient | null {
    if (!this.#cfToken) return null;
    if (!this.#cf) {
      this.#cf = new CfClient(this.#cfToken, { fetch: this.#fetch });
      const { zoneId, zoneName, cfAccountId } = this.settings;
      if (zoneId && zoneName) this.#cf.seedZone({ id: zoneId, name: zoneName, accountId: cfAccountId });
    }
    return this.#cf;
  }

  /** This account's Cloudflare connections (OAuth or pasted token). */
  get connections(): ConnectionService {
    return (this.#connections ??= new ConnectionService({
      accountId: this.accountId,
      scope: this.scope,
      env: this.env,
      fetch: this.#fetch,
      onBroken: info => {
        logAudit(this, {
          actor_type: 'system', action: 'cf_connection.broken',
          resource_type: 'cf_connection', resource_id: info.id, resource_name: info.label,
          after_value: { status: 'broken', detail: info.detail },
        });
        return notifyConnectionBroken(this, info);
      },
    }));
  }

  /** Remember (from loadTenant) whether the account has any connection, for the synchronous availability checks. */
  setHasConnections(has: boolean): void { this.#hasConnections = has; }

  /** Is any Cloudflare credential available: the self-host token, or a connection (whatever its status)? */
  hasCloudflare(): boolean { return !!this.#cfToken || this.#hasConnections; }

  /**
   * The Cloudflare client that manages `domain`'s zone. The domain (or the nearest parent in this
   * account) is linked to a connection: that connection's client, restricted to its allow-list.
   * Not linked: the self-host token (selfhost mode only) or CfNotConfiguredError.
   * A broken or revoked connection throws CfConnectionError.
   */
  async cfFor(domain: string): Promise<CfClient> {
    const linked = await this.#connectionFor(domain);
    if (linked) return this.connections.clientFor(linked);
    const cf = this.cf();
    if (cf) return cf;
    if (this.mode === 'selfhost' || !(await this.connections.hasActive())) throw new CfNotConfiguredError();
    throw new CfNotConfiguredError(`${domain} is not linked to a Cloudflare connection`);
  }

  async #connectionFor(domain: string): Promise<string | null> {
    this.#links ??= this.scope.domains.list().then(rows => new Map(rows.map(r => [r.domain.toLowerCase(), r.cf_connection_id ?? null] as const)));
    const links = await this.#links;
    for (const name of zoneCandidates(domain)) {
      if (links.has(name)) return links.get(name)!;
    }
    return null;
  }

  /** Like cf(), but throws CfNotConfiguredError when there is no token. */
  requireCf(): CfClient {
    const cf = this.cf();
    if (!cf) throw new CfNotConfiguredError();
    return cf;
  }

  /** The Cloudflare zone this domain lives in (resolved per domain through its connection, cached for this tenant context). */
  async zoneFor(domain: string): Promise<CfZone> {
    return (await this.cfFor(domain)).zoneFor(domain);
  }

  /**
   * Zone id of the base domain when it differs from `zoneId`: where installs from before per-domain
   * zones wrote every domain's MTA-STS/SPF records. Used to find legacy records that 404 in their own zone.
   */
  legacyZoneId(zoneId: string): string | undefined {
    const base = this.settings.zoneId;
    return base && base !== zoneId ? base : undefined;
  }

  /** Zone of the reports domain; throws CfZoneNotFoundError when it isn't configured or has no zone. */
  reportsZone(): Promise<CfZone> {
    const rd = this.settings.reportsDomain;
    if (!rd) return Promise.reject(new CfZoneNotFoundError('(reports domain not configured)'));
    return this.zoneFor(rd);
  }

  /**
   * The account's workers.dev subdomain (the `acme` in `worker.acme.workers.dev`). Stored once
   * resolved; looked up lazily because only a few features need it.
   */
  async workersSubdomain(): Promise<string | undefined> {
    const known = this.settings.workersSubdomain;
    if (known) return known;
    const cf = this.cf();
    const cfAccountId = this.settings.cfAccountId;
    if (!cf || !cfAccountId) return undefined;
    try {
      const sub = (await cf.workersSubdomain(cfAccountId))?.subdomain;
      if (sub) {
        this.settings.workersSubdomain = sub;
        await this.scope.settings.set('workers_subdomain', sub).catch(() => {});
      }
      return sub;
    } catch {
      return undefined;
    }
  }

  /** Whether this tenant opted in to anonymous telemetry. Read once per context. */
  telemetryEnabled(): Promise<boolean> {
    this.#telemetry ??= this.scope.settings.get('telemetry_opted_in').then(r => r?.value === 'true');
    return this.#telemetry;
  }

  // env holds secrets (CLOUDFLARE_API_TOKEN, API_KEY): never let a log line or JSON.stringify reach it.
  toJSON(): { redacted: true; accountId: string } { return { redacted: true, accountId: this.accountId }; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return `TenantContext { accountId: '${this.accountId}', mode: '${this.mode}' }`; }

  /** Forget the Cloudflare client and cached flags after settings changed. */
  invalidate(): void {
    this.#cf = undefined;
    this.#links = undefined;
    this.#connections?.invalidate();
    this.#telemetry = undefined;
  }
}

export type { ResolvedAccount };
