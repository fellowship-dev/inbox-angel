// The only place the Worker talks to api.cloudflare.com.
//
// One CfClient is bound to one API token. It resolves the zone of each domain on
// demand (by the domain's registrable name) and remembers the answers for its own
// lifetime, which is one request or one cron workspace. Nothing is cached at module
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
  constructor(message = 'Cloudflare credentials not configured') {
    super(message);
    this.name = 'CfNotConfiguredError';
  }
}
/** The connection's owner did not allow Inbox Angel to manage this zone (or Cloudflare account). */
export class CfZoneNotAllowedError extends Error {
  /**
   * kind 'shadow': `domain` falls inside `zone`, a child zone of an allowed zone that is not on the list. Writing it
   * to the allowed parent would be shadowed by the delegation (it would "succeed" and do nothing), so it is refused.
   */
  constructor(readonly zone: string, readonly connectionId?: string, readonly kind: 'zone' | 'account' | 'shadow' = 'zone', readonly domain?: string) {
    super(kind === 'shadow'
      ? `${domain ?? 'this name'} belongs to zone ${zone}, which isn't on this Cloudflare connection's allow-list (writing it to the parent zone would have no effect): allow ${zone} too`
      : kind === 'zone'
        ? `Zone ${zone} is not in this Cloudflare connection's allow-list`
        : `Cloudflare account ${zone} is not the one this connection belongs to`);
    this.name = 'CfZoneNotAllowedError';
  }
}
/** None of the domain's candidate zones exists on the token's Cloudflare account. */
export class CfZoneNotFoundError extends Error {
  constructor(readonly domain: string) {
    super(`No Cloudflare zone found for ${domain}`);
    this.name = 'CfZoneNotFoundError';
  }
}

/** The domain's Cloudflare connection cannot be used: it needs reconnecting (`broken`), was disconnected (`revoked`), or is gone (`missing`). */
export class CfConnectionError extends Error {
  constructor(
    readonly code: 'broken' | 'revoked' | 'missing',
    readonly connectionId: string,
    readonly label?: string,
  ) {
    super(code === 'missing'
      ? 'Cloudflare connection not found'
      : `Cloudflare connection "${label ?? connectionId}" is ${code}: ${code === 'broken' ? 'reconnect it' : 'it was disconnected'}`);
    this.name = 'CfConnectionError';
  }
}

export interface CfZone { id: string; name: string; cfAccountId?: string }

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

/**
 * What a client may touch. A client built for a stored connection carries the owner's allow-list: it
 * refuses (before any request leaves the Worker) everything under a zone that is not on the list,
 * whatever the token itself could do.
 */
export interface CfPolicy {
  /** Throws to refuse `method path` (the path as passed to request(), without the API prefix, and its query). */
  request(method: string, path: string, query?: CfRequestOptions['query']): void;
  /** May zoneFor() ask Cloudflare whether this zone name exists? (False: it is skipped, nothing is sent.) */
  lookup(zoneName: string): boolean;
  /** Throws to refuse a name that falls inside a known child zone that is not allowed. */
  blocked(name: string): void;
  /** Throws to refuse a zone that zoneFor() found for `domain`. */
  zone(zone: CfZone, domain: string): void;
}

export interface CfClientOptions {
  fetch?: typeof fetch;
  policy?: CfPolicy;
  /**
   * Called once when Cloudflare answers 401 to the current token; returns a fresh token to retry the
   * request with, or null. (OAuth access tokens: refresh once, then retry.)
   */
  onUnauthorized?: () => Promise<string | null>;
}

export interface CfRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

interface CfEnvelope<T> { success?: boolean; result?: T; errors?: CfErrorDetail[] }

/**
 * Candidate zone names for a domain, longest first, never below two labels:
 * `a.b.acme.com` -> `a.b.acme.com`, `b.acme.com`, `acme.com`. Zones can nest
 * (`example.com` and a delegated `sub.example.com`), and the most specific zone is the one
 * that serves the name, so the longest candidate that exists on the account wins. Names
 * Cloudflare doesn't know (`co.uk`, `b.acme.com` when it isn't a zone) simply don't match.
 */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Dot segments, encoded separators and backslashes never belong in an API path built from ids. */
function assertSafePath(path: string): void {
  const p = path.split('?')[0];
  if (p.split('/').some(seg => seg === '.' || seg === '..') || /%|\\|\/\//.test(p)) {
    throw new CfApiError('Cloudflare request refused: unsafe path', 'REQUEST', '[invalid]');
  }
}

export class CfClient {
  #token: string | (() => Promise<string>);
  readonly #fetch: typeof fetch;
  readonly #policy?: CfPolicy;
  readonly #onUnauthorized?: () => Promise<string | null>;
  readonly #zones = new Map<string, Promise<CfZone | null>>();

  /** `token` may be a function, called for every request (so an expiring token is refreshed lazily). */
  constructor(token: string | (() => Promise<string>), opts: CfClientOptions = {}) {
    if (!token) throw new CfNotConfiguredError();
    this.#token = token;
    this.#policy = opts.policy;
    this.#onUnauthorized = opts.onUnauthorized;
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
    assertSafePath(path);
    this.#policy?.request(method.toUpperCase(), path, opts.query);
    return this.#send<T>(method, path, opts, false);
  }

  async #send<T>(method: string, path: string, opts: CfRequestOptions, retried: boolean): Promise<T> {
    const url = new URL(CF_API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const shown = url.pathname.slice(new URL(CF_API).pathname.length) + url.search;

    // Resolved first: a token that cannot be produced (broken connection) is its own error, not a network failure.
    const bearer = await this.#bearer();
    let res: Response;
    try {
      res = await this.#fetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
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
    if (res.status === 401 && !retried && this.#onUnauthorized) {
      const fresh = await this.#onUnauthorized();
      if (fresh) {
        this.#token = fresh;
        return this.#send<T>(method, path, opts, true);
      }
    }
    if (res.status === 401 || res.status === 403) throw new CfAuthError(message, method, shown, res.status, details);
    if (res.status === 404) throw new CfNotFoundError(message, method, shown, res.status, details);
    throw new CfApiError(message, method, shown, res.status, details);
  }

  async #bearer(): Promise<string> {
    return typeof this.#token === 'function' ? this.#token() : this.#token;
  }

  // ── Zones ───────────────────────────────────────────────────

  /**
   * Pre-load a zone we already know (e.g. from stored settings). It answers for its own name; a
   * longer candidate (a nested zone) is still looked up first, so the seed never shadows it.
   */
  seedZone(zone: CfZone): void {
    this.#zones.set(zone.name.toLowerCase(), Promise.resolve(zone));
  }

  /** The zone a domain lives in. Throws CfZoneNotFoundError when the account has none. */
  async zoneFor(domain: string): Promise<CfZone> {
    let skipped = false;
    for (const name of zoneCandidates(domain)) {
      // A name inside a known, non-allowed child zone must not fall through to the parent.
      this.#policy?.blocked(name);
      // A restricted client asks only about allowed zones and about names below them (a child zone created
      // since the list was saved is found here, and refused by zone() below).
      if (this.#policy && !this.#policy.lookup(name)) { skipped = true; continue; }
      const zone = await this.#lookupZone(name);
      if (zone) {
        this.#policy?.zone(zone, domain);
        return zone;
      }
    }
    // Nothing allowed matched, and names were skipped: say "not allowed", not "does not exist".
    if (skipped) throw new CfZoneNotAllowedError(domain);
    throw new CfZoneNotFoundError(domain);
  }

  #lookupZone(name: string): Promise<CfZone | null> {
    let hit = this.#zones.get(name);
    if (!hit) {
      hit = this.request<{ id: string; name: string; account?: { id: string } }[]>('GET', '/zones', { query: { name } })
        .then(list => {
          const z = list?.[0];
          return z ? { id: z.id, name: z.name.toLowerCase(), cfAccountId: z.account?.id } : null;
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

  /** Every active zone the token can see (paged: Cloudflare caps a page at 50). */
  async listZones(): Promise<{ id: string; name: string; status: string; account?: { id: string } }[]> {
    const PER_PAGE = 50;
    const out: { id: string; name: string; status: string; account?: { id: string } }[] = [];
    for (let page = 1; page <= 40; page++) {
      const batch = (await this.request<{ id: string; name: string; status: string; account?: { id: string } }[]>('GET', '/zones', { query: { per_page: PER_PAGE, page, status: 'active' } })) ?? [];
      out.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return out;
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

  /** Idempotent: a record that is already gone is not an error. Returns whether something was deleted. */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
      return true;
    } catch (e) {
      if (!(e instanceof CfNotFoundError)) throw e;
      return false;
    }
  }

  // ── Cloudflare-account-level ───────────────────────────────────────────

  /** API tokens only: is this token valid (`status: active`)? */
  verifyToken(): Promise<{ id?: string; status: string; expires_on?: string }> {
    return this.request('GET', '/user/tokens/verify');
  }

  /** Cloudflare accounts the token can see. */
  listAccounts(): Promise<{ id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>('GET', '/accounts', { query: { per_page: 50 } }).then(r => r ?? []);
  }

  workersSubdomain(cfAccountId: string): Promise<{ subdomain: string } | null> {
    return this.request('GET', `/accounts/${cfAccountId}/workers/subdomain`);
  }
}

/** Cloudflare's own message(s) for a failure, without the request line: what a user should read. */
export function cfErrorText(e: unknown): string {
  if (e instanceof CfError) return e.details.map(d => d.message).join(', ') || (e.status ? `HTTP ${e.status}` : e.message);
  return e instanceof Error ? e.message : String(e);
}
