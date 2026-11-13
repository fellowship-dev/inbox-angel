// Read-only public-DNS preview of a claimed-but-unverified domain (GET /api/domains/claims/:id/preview).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { dohFetch, fakeResolver, type Zone } from '../../packages/dns-checks/test/helpers';
import { COMMON_DKIM_SELECTORS } from '@inbox-angel/dns-checks';
import { __resetPreviewCacheForTests, mapSpf, previewClaimDns } from '../../src/domains/claim-preview';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;

const SNAPSHOT_TABLES = ['domains', 'check_results', 'domain_claims', 'audit_log', 'settings', 'monitor_subscriptions'];

let zone: Zone;
let dnsCalls: string[];
beforeEach(() => {
  __resetPreviewCacheForTests();
  zone = {};
  dnsCalls = [];
});
afterEach(() => vi.unstubAllGlobals());

const stubDns = () => vi.stubGlobal('fetch', dohFetch(zone, dnsCalls));

async function world(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const mk = async (email: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', ?)").run(ws, `reports.${email.split('@')[0]}.test`);
    return { token, ws };
  };
  const A = await mk('a@example.com');
  const B = await mk('b@example.com');
  stubDns();
  const claim = async (who: { token: string }, domain: string) => (await json(await call(env, 'POST', '/api/domains', { key: who.token, body: { domain } }))).claim as { id: number };
  const preview = (who: { token: string }, id: number) => call(env, 'GET', `/api/domains/claims/${id}/preview`, { key: who.token });
  const snapshot = () => Object.fromEntries(SNAPSHOT_TABLES.map(t => [t, rows(`SELECT * FROM ${t} ORDER BY rowid`)]));
  return { db, env, rows, A, B, claim, preview, snapshot };
}

const published: Zone = {
  'TXT acme.com': ['v=spf1 include:_spf.google.com ~all'],
  'TXT _spf.google.com': ['v=spf1 ip4:1.2.3.4 ~all'],
  'TXT _dmarc.acme.com': ['v=DMARC1; p=none; rua=mailto:x@acme.com'],
  'TXT google._domainkey.acme.com': ['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3'],
  'MX acme.com': ['10 mx.acme.com.'],
};

describe('GET /api/domains/claims/:id/preview', () => {
  it('returns the public DNS view of the workspace’s own pending claim', async () => {
    const w = await world();
    Object.assign(zone, published);
    const { id } = await w.claim(w.A, 'acme.com');
    const res = await w.preview(w.A, id);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      domain: 'acme.com', source: 'public_dns', cached: false,
      spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', over_limit: false },
      dmarc: { status: 'found', policy: 'none', inherited: false, found_at: '_dmarc.acme.com' },
      dkim: { status: 'found', selectors: ['google._domainkey.acme.com'], scanned: COMMON_DKIM_SELECTORS.length, failed: 0 },
      mx: { status: 'found' }, lookup_failed: [],
    });
    expect(Number.isNaN(Date.parse(body.checked_at))).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/inboxangel-verify|token/i);
  });

  it('another workspace’s claim is a 404, and no DNS is looked up', async () => {
    const w = await world();
    const { id } = await w.claim(w.A, 'acme.com');
    dnsCalls.length = 0;
    expect((await w.preview(w.B, id)).status).toBe(404);
    expect(dnsCalls).toEqual([]);
  });

  it('a claim another workspace has since won is a 409 claim_lost with no preview', async () => {
    const w = await world();
    const { id } = await w.claim(w.A, 'acme.com');
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(w.B.ws);
    dnsCalls.length = 0;
    const res = await w.preview(w.A, id);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'another workspace has already verified this domain', code: 'claim_lost' });
    expect(dnsCalls).toEqual([]);

    w.db.sqlite.prepare("UPDATE domain_claims SET status = 'lost' WHERE id = ?").run(id);
    expect((await w.preview(w.A, id)).status).toBe(409);
  });

  it('writes nothing: no domains, check results, claims, audit or settings rows', async () => {
    const w = await world();
    Object.assign(zone, published);
    const { id } = await w.claim(w.A, 'acme.com');
    const before = w.snapshot();
    expect((await w.preview(w.A, id)).status).toBe(200);
    expect((await w.preview(w.A, id)).status).toBe(200); // cached
    expect(w.snapshot()).toEqual(before);
  });

  it('shows a DNS error as an error, never as a missing record', async () => {
    const w = await world();
    Object.assign(zone, { ...published, 'TXT _dmarc.acme.com': 'SERVFAIL', 'MX acme.com': 'TIMEOUT' });
    const { id } = await w.claim(w.A, 'acme.com');
    const body = await json(await w.preview(w.A, id));
    expect(body.dmarc.status).toBe('error');
    expect(body.mx.status).toBe('error');
    expect(body.spf.status).toBe('found');
    expect(body.lookup_failed).toEqual(['dmarc', 'mx']);
  });

  it('a cache hit runs no DNS and does not count against the limit', async () => {
    const w = await world();
    Object.assign(zone, published);
    const { id } = await w.claim(w.A, 'acme.com');
    const first = await json(await w.preview(w.A, id));
    const after = dnsCalls.length;
    for (let i = 0; i < 15; i++) {
      const res = await w.preview(w.A, id);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.cached).toBe(true);
      expect(body.checked_at).toBe(first.checked_at);
    }
    expect(dnsCalls.length).toBe(after);
  });

  it('the 11th cache miss in a minute is a 429 with no DNS lookups; a hit still answers', async () => {
    const w = await world();
    const ids: number[] = [];
    for (let i = 0; i < 11; i++) ids.push((await w.claim(w.A, `d${i}.example.com`)).id);
    for (const id of ids.slice(0, 10)) expect((await w.preview(w.A, id)).status).toBe(200);
    const before = dnsCalls.length;
    const res = await w.preview(w.A, ids[10]);
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'Checked too often. Try again in a minute.', code: 'rate_limited', retry_after: 60 });
    expect(dnsCalls.length).toBe(before);
    expect((await w.preview(w.A, ids[0])).status).toBe(200); // cached: costs no DNS
  });

  it('limits per user: another person is unaffected', async () => {
    const w = await world();
    const a: number[] = [];
    for (let i = 0; i < 11; i++) a.push((await w.claim(w.A, `a${i}.example.com`)).id);
    for (const id of a.slice(0, 10)) await w.preview(w.A, id);
    expect((await w.preview(w.A, a[10])).status).toBe(429);
    const b = (await w.claim(w.B, 'b-only.example.com')).id;
    expect((await w.preview(w.B, b)).status).toBe(200);
  });

  it('uses the DNS_PREVIEW_LIMITER binding, keyed by user, when it is bound', async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length < 2 }) };
    const w = await world({ DNS_PREVIEW_LIMITER: limiter });
    const one = (await w.claim(w.A, 'one.example.com')).id;
    const two = (await w.claim(w.A, 'two.example.com')).id;
    expect((await w.preview(w.A, one)).status).toBe(200);
    expect((await w.preview(w.A, two)).status).toBe(429);
    expect(keys).toHaveLength(2);
    expect(keys.every(k => /^user:/.test(k))).toBe(true);
  });
});

describe('previewClaimDns mapping', () => {
  // Fresh cache per call: each lookup here is meant to hit the (fake) DNS.
  const run = (z: Zone, opts: { now?: number } = {}) => (__resetPreviewCacheForTests(), previewClaimDns('acme.com', { resolver: fakeResolver(z), ...opts }));

  it('everything found', async () => {
    const v = await run(published);
    expect(v.spf).toMatchObject({ status: 'found', lookup_count: 1, over_limit: false });
    expect(v.dmarc).toMatchObject({ status: 'found', policy: 'none' });
    expect(v.dkim.status).toBe('found');
    expect(v.mx.status).toBe('found');
    expect(v.lookup_failed).toEqual([]);
  });

  it('nothing published (NXDOMAIN): missing, not_found, none: and no error', async () => {
    const v = await run({});
    expect(v.spf).toMatchObject({ status: 'missing', record: null });
    expect(v.dmarc).toMatchObject({ status: 'missing', record: null, policy: null });
    expect(v.dkim).toEqual({ status: 'not_found', selectors: [], scanned: COMMON_DKIM_SELECTORS.length, failed: 0 });
    expect(v.mx.status).toBe('none');
    expect(v.lookup_failed).toEqual([]);
  });

  it('SERVFAIL everywhere is an error everywhere, never missing', async () => {
    const z: Zone = { 'TXT acme.com': 'SERVFAIL', 'TXT _dmarc.acme.com': 'SERVFAIL', 'TXT _dmarc.acme.com.': 'SERVFAIL', 'MX acme.com': 'SERVFAIL' };
    for (const s of COMMON_DKIM_SELECTORS) z[`TXT ${s}._domainkey.acme.com`] = 'SERVFAIL';
    const v = await run(z);
    expect([v.spf.status, v.dmarc.status, v.dkim.status, v.mx.status]).toEqual(['error', 'error', 'error', 'error']);
    expect(v.lookup_failed).toEqual(['spf', 'dmarc', 'dkim', 'mx']);
  });

  it('SPF: several records and a dangling include are invalid; over 10 lookups is a found record flagged over_limit', async () => {
    const multi = await run({ 'TXT acme.com': ['v=spf1 -all', 'v=spf1 +all'] });
    expect(multi.spf).toMatchObject({ status: 'invalid', record: null });
    expect(multi.spf.issues.join(' ')).toMatch(/2 SPF records/);

    const dangling = await run({ 'TXT acme.com': ['v=spf1 include:nowhere.example.net -all'] });
    expect(dangling.spf).toMatchObject({ status: 'invalid', record: 'v=spf1 include:nowhere.example.net -all' });

    const includes = Array.from({ length: 11 }, (_, i) => `include:i${i}.example.net`);
    const z: Zone = { 'TXT acme.com': [`v=spf1 ${includes.join(' ')} ~all`] };
    for (let i = 0; i < 11; i++) z[`TXT i${i}.example.net`] = ['v=spf1 ip4:1.2.3.4 -all'];
    const over = await run(z);
    expect(over.spf).toMatchObject({ status: 'found', over_limit: true, lookup_count: 11 });
  });

  it('SPF: a failed include lookup is an error', async () => {
    const v = await run({ 'TXT acme.com': ['v=spf1 include:broken.example.net ~all'], 'TXT broken.example.net': 'SERVFAIL' });
    expect(v.spf.status).toBe('error');
  });

  it('DMARC: several records, and one inherited from the organisational domain', async () => {
    expect((await run({ 'TXT _dmarc.acme.com': ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] })).dmarc.status).toBe('multiple');
    __resetPreviewCacheForTests();
    const inherited = await previewClaimDns('mail.acme.com', { resolver: fakeResolver({ 'TXT _dmarc.acme.com': ['v=DMARC1; p=reject'] }) });
    expect(inherited.dmarc).toMatchObject({ status: 'found', policy: 'reject', inherited: true, found_at: '_dmarc.acme.com' });
  });

  it('DKIM: partial errors do not hide a found key, but make "none found" an error', async () => {
    const found = await run({ 'TXT google._domainkey.acme.com': ['v=DKIM1; p=AAAA'], 'TXT selector1._domainkey.acme.com': 'SERVFAIL' });
    expect(found.dkim).toMatchObject({ status: 'found', selectors: ['google._domainkey.acme.com'], failed: 1 });
    expect(found.lookup_failed).not.toContain('dkim');
    const partial = await run({ 'TXT selector1._domainkey.acme.com': 'SERVFAIL' });
    expect(partial.dkim).toMatchObject({ status: 'error', selectors: [], failed: 1 });
    expect(partial.lookup_failed).toContain('dkim');
  });

  it('caches per domain for 60 s, keeps checked_at, and evicts the oldest past 500', async () => {
    const calls: string[] = [];
    const resolver = fakeResolver(published, calls);
    const t0 = 1_800_000_000_000;
    const first = await previewClaimDns('acme.com', { resolver, now: t0 });
    const n = calls.length;
    const hit = await previewClaimDns('ACME.com.', { resolver, now: t0 + 59_000 });
    expect(hit).toMatchObject({ cached: true, checked_at: first.checked_at });
    expect(calls.length).toBe(n);
    expect((await previewClaimDns('acme.com', { resolver, now: t0 + 60_000 })).cached).toBe(false);

    __resetPreviewCacheForTests();
    const quiet = fakeResolver({});
    await previewClaimDns('first.example.com', { resolver: quiet, now: t0 });
    for (let i = 0; i < 500; i++) await previewClaimDns(`d${i}.example.com`, { resolver: quiet, now: t0 });
    expect((await previewClaimDns('first.example.com', { resolver: quiet, now: t0 })).cached).toBe(false); // evicted
    expect((await previewClaimDns('d499.example.com', { resolver: quiet, now: t0 })).cached).toBe(true);
  });

  it('mapSpf treats temperror as error', () => {
    expect(mapSpf({ domain: 'x', status: 'temperror', record: null, lookupCount: 0, voidLookupCount: 0, lookupLimitExceeded: false, voidLimitExceeded: false, issues: [], includes: [] }).status).toBe('error');
  });
});
