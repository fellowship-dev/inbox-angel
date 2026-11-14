// Read-only public-DNS preview of a claimed-but-unverified domain (GET /api/domains/claims/:id/preview).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { dohFetch, fakeResolver, type Zone } from '../../packages/dns-checks/test/helpers';
import { COMMON_DKIM_SELECTORS } from '@ready-set-mail/dns-checks';
import { __resetPreviewCacheForTests, previewClaimDns } from '../../src/domains/claim-preview';
import { snapshotDns } from '../../src/email/dns-snapshot';
import { assessDomain } from '../../web/src/lib/levels';
import { previewAssessment } from '../../web/src/lib/claim-preview';

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
      nxdomain: false,
      dmarc: { status: 'found', policy: 'none', issue: null, inherited_from: null, record: 'v=DMARC1; p=none; rua=mailto:x@acme.com' },
      dkim: { status: 'found', selectors: ['google._domainkey.acme.com'], scanned: COMMON_DKIM_SELECTORS.length, failed: 0 },
      mx: { status: 'found' }, lookup_failed: [],
    });
    expect(Number.isNaN(Date.parse(body.checked_at))).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/readysetmail-verify|token/i);
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

  it('nothing published (NXDOMAIN at the apex): missing everywhere, and nxdomain says the name does not exist', async () => {
    const v = await run({});
    expect(v.nxdomain).toBe(true);
    expect(v.spf).toMatchObject({ status: 'missing', record: null, over_limit: false });
    expect(v.dmarc).toEqual({ status: 'missing', policy: null, issue: null, inherited_from: null, record: null, pct: null });
    expect(v.dkim).toEqual({ status: 'not_found', selectors: [], scanned: COMMON_DKIM_SELECTORS.length, failed: 0 });
    expect(v.mx.status).toBe('none');
    expect(v.lookup_failed).toEqual([]);
  });

  it('a domain that exists with no records is missing, not nxdomain', async () => {
    const v = await run({ 'TXT acme.com': 'NODATA' });
    expect(v.nxdomain).toBe(false);
    expect(v.spf.status).toBe('missing');
    expect(v.dmarc.status).toBe('missing');
  });

  it('SERVFAIL everywhere is an error everywhere, never missing', async () => {
    const z: Zone = { 'TXT acme.com': 'SERVFAIL', 'TXT _dmarc.acme.com': 'SERVFAIL', 'TXT _dmarc.acme.com.': 'SERVFAIL', 'MX acme.com': 'SERVFAIL' };
    for (const s of COMMON_DKIM_SELECTORS) z[`TXT ${s}._domainkey.acme.com`] = 'SERVFAIL';
    const v = await run(z);
    expect([v.spf.status, v.dmarc.status, v.dkim.status, v.mx.status]).toEqual(['error', 'error', 'error', 'error']);
    expect(v.lookup_failed).toEqual(['spf', 'dmarc', 'dkim', 'mx']);
  });

  it('SPF: over 10 lookups is a found record flagged over_limit; exactly 10 is not', async () => {
    const chain = (n: number) => {
      const z: Zone = { 'TXT acme.com': [`v=spf1 ${Array.from({ length: n }, (_, i) => `include:i${i}.example.net`).join(' ')} ~all`] };
      for (let i = 0; i < n; i++) z[`TXT i${i}.example.net`] = ['v=spf1 ip4:1.2.3.4 -all'];
      return z;
    };
    expect((await run(chain(11))).spf).toMatchObject({ status: 'found', over_limit: true, lookup_count: 11 });
    expect((await run(chain(10))).spf).toMatchObject({ status: 'found', over_limit: false, lookup_count: 10 });
  });

  it('SPF: a failed include lookup or a failed apex lookup is an error, never missing', async () => {
    expect((await run({ 'TXT acme.com': ['v=spf1 include:broken.example.net ~all'], 'TXT broken.example.net': 'SERVFAIL' })).spf.status).toBe('error');
    const v = await run({ 'TXT acme.com': 'SERVFAIL' });
    expect(v.spf).toMatchObject({ status: 'error', record: null });
    expect(v.lookup_failed).toContain('spf');
  });

  it('DMARC: a subdomain with no record of its own gets its parent\'s sp=, inherited_from the parent', async () => {
    const v = await previewClaimDns('mail.acme.com', { resolver: fakeResolver({ 'TXT _dmarc.acme.com': ['v=DMARC1; p=none; sp=reject'] }) });
    expect(v.dmarc).toEqual({ status: 'found', policy: 'reject', issue: null, inherited_from: 'acme.com', record: 'v=DMARC1; p=none; sp=reject', pct: 100 });
  });

  it('DMARC: several records and an invalid record give no policy, with the issue named', async () => {
    const multi = await run({ 'TXT _dmarc.acme.com': ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] });
    expect(multi.dmarc).toMatchObject({ status: 'found', policy: null, issue: 'multiple', inherited_from: null });
    expect(multi.dmarc.record).toContain('v=DMARC1; p=none');
    const invalid = await run({ 'TXT _dmarc.acme.com': ['v=DMARC1; rua=mailto:a@acme.com'] });
    expect(invalid.dmarc).toMatchObject({ status: 'found', policy: null, issue: 'invalid', record: 'v=DMARC1; rua=mailto:a@acme.com' });
  });

  it('DMARC: a failed lookup is an error, never missing', async () => {
    const v = await run({ ...published, 'TXT _dmarc.acme.com': 'SERVFAIL' });
    expect(v.dmarc).toEqual({ status: 'error', policy: null, issue: null, inherited_from: null, record: null, pct: null });
    expect(v.lookup_failed).toContain('dmarc');
  });

  it('makes no more DNS queries than the snapshot, DKIM scan and MX need (each name once)', async () => {
    const calls: string[] = [];
    __resetPreviewCacheForTests();
    await previewClaimDns('acme.com', { resolver: fakeResolver(published, calls) });
    expect(calls.filter(c => c === 'TXT acme.com')).toHaveLength(1);
    expect(calls.filter(c => c === 'TXT _dmarc.acme.com')).toHaveLength(1);
  });

  it('DKIM: partial errors do not hide a found key, but make "none found" an error', async () => {
    const found = await run({ 'TXT google._domainkey.acme.com': ['v=DKIM1; p=AAAA'], 'TXT selector1._domainkey.acme.com': 'SERVFAIL' });
    expect(found.dkim).toMatchObject({ status: 'found', selectors: ['google._domainkey.acme.com'], failed: 1 });
    expect(found.lookup_failed).not.toContain('dkim');
    const partial = await run({ 'TXT selector1._domainkey.acme.com': 'SERVFAIL' });
    expect(partial.dkim).toMatchObject({ status: 'error', selectors: [], failed: 1 });
    expect(partial.lookup_failed).toContain('dkim');
  });

  describe('DKIM when every name answers with the same TXT record (gov.uk answers each with its DMARC record)', () => {
    const DMARC = 'v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@acme.com';
    /** Every common selector answers `record`; the random probe name answers per `probe`: alike (a true wildcard), with a failure, or not at all. */
    const RANDOM = /^TXT ia-wc-[0-9a-f]{16}\._domainkey\.acme\.com$/;
    const wildcard = (record: string, probe: 'same' | 'SERVFAIL' | 'none' = 'same'): Zone => {
      const z: Zone = { ...published, 'TXT _dmarc.acme.com': [DMARC], ...Object.fromEntries(COMMON_DKIM_SELECTORS.map(s => [`TXT ${s}._domainkey.acme.com`, [record]])) };
      return new Proxy(z, { get: (t, k) => (typeof k === 'string' && RANDOM.test(k) ? (probe === 'same' ? [record] : probe === 'none' ? undefined : 'SERVFAIL') : t[k]) });
    };

    it('is "wildcard", not "found": no selectors are listed', async () => {
      const v = await run(wildcard(DMARC));
      expect(v.dkim).toEqual({ status: 'wildcard', selectors: [], scanned: COMMON_DKIM_SELECTORS.length, failed: 0 });
      expect(v.lookup_failed).not.toContain('dkim');
    });

    it('an identical DKIM key everywhere is a wildcard too', async () => {
      const v = await run(wildcard('v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'));
      expect(v.dkim).toMatchObject({ status: 'wildcard', selectors: [] });
    });

    const KEY = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A';

    it('the same real key at every selector, with nothing at a random name, is found, not a wildcard', async () => {
      const v = await run(wildcard(KEY, 'none'));
      expect(v.dkim).toMatchObject({ status: 'found', failed: 0 });
      expect(v.dkim.selectors).toHaveLength(COMMON_DKIM_SELECTORS.length);
    });

    it('a failed random probe is "error" (not found, not missing, not wildcard)', async () => {
      const v = await run(wildcard(KEY, 'SERVFAIL'));
      expect(v.dkim).toMatchObject({ status: 'error', selectors: [], failed: 1 });
      expect(v.lookup_failed).toContain('dkim');
    });

    it('through the API for a pending claim', async () => {
      const w = await world();
      vi.stubGlobal('fetch', dohFetch(wildcard(DMARC), dnsCalls));
      const { id } = await w.claim(w.A, 'acme.com');
      const body = await json(await w.preview(w.A, id));
      expect(body.dkim).toMatchObject({ status: 'wildcard', selectors: [] });
      expect(JSON.stringify(body.dkim)).not.toContain('_domainkey');
    });
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

});

describe('the preview and the overview card cannot disagree', () => {
  // What the daily refresh stores for a domain, as the overview card's summary.
  async function overviewInput(domain: string, z: Zone) {
    const snap = await snapshotDns(domain, fakeResolver(z));
    return {
      spf_record: snap.spf_record ?? null,
      dmarc_policy: snap.dmarc?.policy ?? null,
      dmarc_issue: snap.dmarc?.issue ?? null,
      dmarc_inherited_from: snap.dmarc?.inherited_from ?? null,
      // What recordDnsCheck and updateSpfLookupCount store from the same snapshot, so the stricter SPF and pct= verdicts agree too.
      spf_lookup_count: snap.spf_lookup_count ?? null,
      dmarc_pct: snap.dmarc?.pct ?? null,
      dns_checked_at: 1_800_000_000,
      dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null,
    };
  }

  const cases: Array<[string, string, Zone]> = [
    ['everything published', 'acme.com', published],
    ['enforced', 'acme.com', { ...published, 'TXT _dmarc.acme.com': ['v=DMARC1; p=reject'] }],
    ['partly enforced (pct=50)', 'acme.com', { ...published, 'TXT _dmarc.acme.com': ['v=DMARC1; p=reject; pct=50'] }],
    ['inherited sp=reject', 'mail.acme.com', { 'TXT mail.acme.com': ['v=spf1 -all'], 'TXT _dmarc.acme.com': ['v=DMARC1; p=none; sp=reject'] }],
    ['inherited p=none', 'mail.acme.com', { 'TXT mail.acme.com': ['v=spf1 -all'], 'TXT _dmarc.acme.com': ['v=DMARC1; p=none'] }],
    ['several DMARC records', 'acme.com', { ...published, 'TXT _dmarc.acme.com': ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }],
    ['invalid DMARC record', 'acme.com', { ...published, 'TXT _dmarc.acme.com': ['v=DMARC1; rua=mailto:a@acme.com'] }],
    ['no SPF', 'acme.com', { 'TXT acme.com': 'NODATA', 'TXT _dmarc.acme.com': ['v=DMARC1; p=none'] }],
    ['nothing published', 'acme.com', {}],
  ];

  it.each(cases)('%s', async (_name, domain, z) => {
    __resetPreviewCacheForTests();
    const preview = await previewClaimDns(domain, { resolver: fakeResolver(z), now: 1_800_000_000_000 });
    const stored = await overviewInput(domain, z);
    if (preview.nxdomain) return expect(previewAssessment(preview as any)).toBeNull();
    expect(previewAssessment(preview as any)).toEqual(assessDomain(stored));
  });
});
