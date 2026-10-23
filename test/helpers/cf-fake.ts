import { vi } from 'vitest';

export interface FakeZone { id: string; cfAccountId?: string }
export interface FakeRecord { id: string; type: string; name: string; content: string }

export interface FakeCall {
  method: string;
  url: string;
  /** `/zones/{id}/...` calls: the zone id; zone lookups: undefined. */
  zoneId?: string;
  body?: any;
  auth?: string | null;
}

/**
 * A small in-memory Cloudflare: zones by name, DNS records per zone. Install it with
 * `stubCloudflare(fake)`; every call is recorded in `fake.calls`.
 */
export class FakeCloudflare {
  readonly calls: FakeCall[] = [];
  readonly records = new Map<string, FakeRecord[]>();
  /** MX answers for DNS-over-HTTPS lookups: name -> `10 mx.host.` strings. */
  readonly mx: Record<string, string[]> = {};
  /** CNAME answers for DNS-over-HTTPS lookups: name -> target. */
  readonly cname: Record<string, string> = {};
  /** Worker routes per zone id, served at /zones/:id/workers/routes. */
  readonly routes: Record<string, { pattern: string; script: string }[]> = {};
  /** When set, a request whose bearer token is not in the set is answered 401 (a revoked / expired token). */
  validTokens?: Set<string>;
  /** Cloudflare accounts the token can see (GET /accounts). */
  accounts: { id: string; name: string }[] = [];
  #nextId = 1;

  constructor(
    readonly zones: Record<string, FakeZone>,
    /** Fail every request with this status (e.g. 403) before touching state. */
    public failWith?: { status: number; message: string },
    /** Fail only calls for this zone id. */
    public failZone?: { zoneId: string; status: number; message: string },
    /** TXT answers for DNS-over-HTTPS lookups: name -> records. Unknown names are NXDOMAIN. */
    public doh: Record<string, string[]> = {},
  ) {}

  seed(zoneId: string, rec: Omit<FakeRecord, 'id'> & { id?: string }): FakeRecord {
    const r = { id: rec.id ?? `seed-${this.#nextId++}`, ...rec };
    this.records.set(zoneId, [...(this.records.get(zoneId) ?? []), r]);
    return r;
  }

  forZone(zoneId: string): FakeCall[] {
    return this.calls.filter(c => c.zoneId === zoneId);
  }

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? '';
      const qtype = (url.searchParams.get('type') ?? '').toUpperCase();
      const isMx = qtype === 'MX';
      const answers = qtype === 'CNAME' ? (this.cname[name] ? [this.cname[name]] : undefined) : isMx ? this.mx[name] : this.doh[name];
      const payload = answers
        ? { Status: 0, Answer: answers.map(data => (isMx ? { type: 15, data } : qtype === 'CNAME' ? { type: 5, data: `${data}.` } : { type: 16, data: `"${data}"` })) }
        : { Status: 3 };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    const m = url.pathname.match(/^\/client\/v4\/zones\/([^/]+)(\/.*)?$/);
    const call: FakeCall = { method, url: url.toString(), zoneId: m?.[1], body, auth: headers.get('authorization') };
    this.calls.push(call);

    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    const ok = (result: unknown) => reply(200, { success: true, result });
    const fail = (status: number, message: string) => reply(status, { success: false, errors: [{ message }] });

    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (this.validTokens && !this.validTokens.has(bearer)) return fail(401, 'Invalid access token');
    if (url.pathname === '/client/v4/user/tokens/verify') return ok({ id: 'tok-id', status: 'active' });
    if (url.pathname === '/client/v4/accounts' && method === 'GET') return ok(this.accounts);

    if (this.failWith) return fail(this.failWith.status, this.failWith.message);
    if (this.failZone && call.zoneId === this.failZone.zoneId) return fail(this.failZone.status, this.failZone.message);

    if (url.pathname === '/client/v4/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      if (name) {
        const z = this.zones[name];
        return ok(z ? [{ id: z.id, name, account: z.cfAccountId ? { id: z.cfAccountId } : undefined }] : []);
      }
      return ok(Object.entries(this.zones).map(([n, z]) => ({ id: z.id, name: n, status: 'active', account: z.cfAccountId ? { id: z.cfAccountId } : undefined })));
    }

    if (m) {
      const zoneId = m[1];
      const rest = m[2] ?? '';
      const list = this.records.get(zoneId) ?? [];
      if (rest === '/workers/routes' && method === 'GET') return ok(this.routes[zoneId] ?? []);
      if (rest === '/dns_records' && method === 'GET') {
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name');
        const matching = list.filter(r => (!type || r.type === type) && (!name || r.name === name));
        const per = Number(url.searchParams.get('per_page')) || matching.length || 1;
        const page = Number(url.searchParams.get('page')) || 1;
        return ok(matching.slice((page - 1) * per, page * per));
      }
      if (rest === '/dns_records' && method === 'POST') {
        const r = { id: String(this.#nextId++).padStart(32, "0"), type: body.type, name: body.name, content: body.content };
        this.records.set(zoneId, [...list, r]);
        return ok(r);
      }
      const one = rest.match(/^\/dns_records\/([^/]+)$/);
      if (one && method === 'GET') {
        const rec = list.find(r => r.id === one[1]);
        return rec ? ok(rec) : fail(404, 'record not found');
      }
      if (one && method === 'PATCH') {
        const rec = list.find(r => r.id === one[1]);
        if (!rec) return fail(404, 'record not found');
        Object.assign(rec, body);
        return ok(rec);
      }
      if (one && method === 'DELETE') {
        if (!list.some(r => r.id === one[1])) return fail(404, 'record not found');
        this.records.set(zoneId, list.filter(r => r.id !== one[1]));
        return ok({ id: one[1] });
      }
    }
    return fail(404, `unhandled ${method} ${url.pathname}`);
  });
}

/** Route global fetch to the fake. Pair with vi.unstubAllGlobals() in afterEach. */
export function stubCloudflare(fake: FakeCloudflare): FakeCloudflare {
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

/**
 * Wrap a sequential fetch mock so zone-by-name lookups answer "no such zone" without consuming
 * the mock's queued responses (a subdomain is checked for a zone of its own before the stored parent).
 */
export function skipZoneLookups(inner: (...a: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === '/client/v4/zones' && url.searchParams.has('name')) {
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }
    return inner(input, init);
  }) as typeof fetch;
}
