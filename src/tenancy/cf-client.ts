// The only place the Worker talks to api.cloudflare.com.
//
// One CfClient is bound to one API token. It resolves the zone of each domain on
// demand (by the domain's registrable name) and remembers the answers for its own
// lifetime, which is one request or one cron account. Nothing is cached at module
// level, so two tenants in one isolate can never see each other's zones.
//
// The token lives in a private field: it never appears in errors, logs, JSON or
// util.inspect output.

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface CfErrorDetail { code?: number; message: string }

/** Base class for every failure talking to Cloudflare. */
export class CfError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly status?: number,
    readonly details: CfErrorDetail[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request never produced a response (DNS, TLS, timeout). */
export class CfNetworkError extends CfError {}
/** 401 / 403: the token is invalid, expired, or lacks the permission. */
export class CfAuthError extends CfError {}
/** 404 from Cloudflare. */
export class CfNotFoundError extends CfError {}
/** Any other non-success answer. */
export class CfApiError extends CfError {}
/** No API token is available for this tenant. */
export class CfNotConfiguredError extends Error {
  constructor() {
    super('Cloudflare credentials not configured');
    this.name = 'CfNotConfiguredError';
  }
}
/** None of the domain's candidate zones exists on the token's Cloudflare account. */
export class CfZoneNotFoundError extends Error {
  constructor(readonly domain: string) {
    super(`No Cloudflare zone found for ${domain}`);
    this.name = 'CfZoneNotFoundError';
  }
}

export interface CfZone { id: string; name: string; accountId?: string }

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
}

export type CfDnsRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
};

export interface CfRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

interface CfEnvelope<T> { success?: boolean; result?: T; errors?: CfErrorDetail[] }

/**
 * Candidate zone names for a domain, shortest first, never below two labels:
 * `a.b.acme.com` -> `acme.com`, `b.acme.com`, `a.b.acme.com`. Cloudflare zones
 * are registrable names, so the first candidate that exists on the account is
 * the zone; names Cloudflare doesn't know (`co.uk`) simply don't match.
 */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = labels.length - 2; i >= 0; i--) out.push(labels.slice(i).join('.'));
  return out;
}

export class CfClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #zones = new Map<string, Promise<CfZone | null>>();

  constructor(token: string, opts: { fetch?: typeof fetch } = {}) {
    if (!token) throw new CfNotConfiguredError();
    this.#token = token;
    // Looked up per call (not captured) so stubbing globalThis.fetch in tests works.
    this.#fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  toJSON(): { redacted: true } { return { redacted: true }; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return 'CfClient { token: [redacted] }'; }

  // ── Raw requests ────────────────────────────────────────────

  /**
   * Call the API and return `result`. Throws a typed CfError on network failure,
   * auth failure, 404 or any `success: false`. A body without a `success` field
   * counts as success when the HTTP status is ok.
   */
  async request<T = unknown>(method: string, path: string, opts: CfRequestOptions = {}): Promise<T> {
    const url = new URL(CF_API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const shown = url.pathname.slice(new URL(CF_API).pathname.length) + url.search;

    let res: Response;
    try {
      res = await this.#fetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new CfNetworkError(`Cloudflare ${method} ${shown} failed: ${e instanceof Error ? e.name : 'network error'}`, method, shown);
    }

    let data: CfEnvelope<T> = {};
    try { data = await res.json() as CfEnvelope<T>; } catch { /* non-JSON body */ }

    if (res.ok && data.success !== false) return data.result as T;

    const details = data.errors ?? [];
    const reason = details.map(e => e.message).join(', ') || `HTTP ${res.status}`;
    const message = `Cloudflare ${method} ${shown}: ${reason}`;
    if (res.status === 401 || res.status === 403) throw new CfAuthError(message, method, shown, res.status, details);
    if (res.status === 404) throw new CfNotFoundError(message, method, shown, res.status, details);
    throw new CfApiError(message, method, shown, res.status, details);
  }

  // ── Zones ───────────────────────────────────────────────────

  /** Pre-load a zone we already know (e.g. from stored settings), so no lookup is needed. */
  seedZone(zone: CfZone): void {
    this.#zones.set(zone.name.toLowerCase(), Promise.resolve(zone));
  }

  /** The zone a domain lives in. Throws CfZoneNotFoundError when the account has none. */
  async zoneFor(domain: string): Promise<CfZone> {
    for (const name of zoneCandidates(domain)) {
      const zone = await this.#lookupZone(name);
      if (zone) return zone;
    }
    throw new CfZoneNotFoundError(domain);
  }

  #lookupZone(name: string): Promise<CfZone | null> {
    let hit = this.#zones.get(name);
    if (!hit) {
      hit = this.request<{ id: string; name: string; account?: { id: string } }[]>('GET', '/zones', { query: { name } })
        .then(list => {
          const z = list?.[0];
          return z ? { id: z.id, name: z.name.toLowerCase(), accountId: z.account?.id } : null;
        });
      this.#zones.set(name, hit);
      // A failed lookup must not stay cached: the next caller retries.
      hit.catch(() => { if (this.#zones.get(name) === hit) this.#zones.delete(name); });
    }
    return hit;
  }

  getZone(zoneId: string): Promise<{ id: string; name: string; account?: { id: string } }> {
    return this.request('GET', `/zones/${zoneId}`);
  }

  listZones(): Promise<{ id: string; name: string; status: string }[]> {
    return this.request('GET', '/zones', { query: { per_page: 200, status: 'active' } });
  }

  // ── DNS records ─────────────────────────────────────────────

  listDnsRecords(zoneId: string, query: { type?: string; name?: string; per_page?: number }): Promise<CfDnsRecord[]> {
    return this.request<CfDnsRecord[]>('GET', `/zones/${zoneId}/dns_records`, { query }).then(r => r ?? []);
  }

  createDnsRecord(zoneId: string, record: CfDnsRecordInput): Promise<CfDnsRecord> {
    return this.request('POST', `/zones/${zoneId}/dns_records`, { body: record });
  }

  patchDnsRecord(zoneId: string, recordId: string, patch: Partial<CfDnsRecordInput>): Promise<CfDnsRecord> {
    return this.request('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { body: patch });
  }

  /** Idempotent: a record that is already gone is not an error. */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    try {
      await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
    } catch (e) {
      if (!(e instanceof CfNotFoundError)) throw e;
    }
  }

  // ── Account-level ───────────────────────────────────────────

  workersSubdomain(accountId: string): Promise<{ subdomain: string } | null> {
    return this.request('GET', `/accounts/${accountId}/workers/subdomain`);
  }
}

/** Cloudflare's own message(s) for a failure, without the request line: what a user should read. */
export function cfErrorText(e: unknown): string {
  if (e instanceof CfError) return e.details.map(d => d.message).join(', ') || (e.status ? `HTTP ${e.status}` : e.message);
  return e instanceof Error ? e.message : String(e);
}
