import { describe, it, expect, vi } from 'vitest';

const dns = vi.hoisted(() => ({ dmarc: undefined as string | null | undefined }));
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { forAccount } from '@inbox-angel/db';
import { call, makeEnv, inviteAndAccept, setupOwner } from '../auth/helpers';
import { handleAnalyticsRoutes } from '../../src/analytics/routes';
import { makeTenant } from '../helpers/tenant';
import { lastDays, seedDomainReports, STORY } from './world';

const SPF = 'v=spf1 include:_spf.google.com ~all';

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, {}) as any;
  const owner = await setupOwner(env);
  const q = forAccount(db, 'acct_default');
  const id = Number((await q.domains.insert({ domain: 'acme.com', rua_address: 'rua@r.test' })).meta.last_row_id);
  db.sqlite.prepare("UPDATE domains SET spf_record = ?, dmarc_policy = 'none' WHERE id = ?").run(SPF, id);
  await seedDomainReports(db, 'acct_default', id, 'acme.com', lastDays(20), STORY);
  return { db, env, owner, id };
}

// The live DMARC lookup is a network call: tests stub it through the same seam the route exposes.
vi.mock('@inbox-angel/dns-checks', async (orig) => ({
  ...(await orig<typeof import('@inbox-angel/dns-checks')>()),
  // undefined = the lookup failed; null = no record; a string = that record.
  createResolver: () => ({ txt: async () => (dns.dmarc === undefined ? { status: 'error', records: [], error: 'offline' } : { status: 'ok', records: dns.dmarc === null ? [] : [dns.dmarc] }) }),
}));

describe('GET /api/domains/:id/analytics', () => {
  it('returns the trend, sender inventory, fixes and readiness for the window', async () => {
    const t = await world();
    const r = await call(t.env, 'GET', `/api/domains/${t.id}/analytics?days=30`, { key: t.owner });
    expect(r.status).toBe(200);
    const body = await r.json() as any;

    expect(body).toMatchObject({ days: 30, domain: { id: t.id, domain: 'acme.com' } });
    expect(body.totals).toMatchObject({ messages: 20 * 95 + 2 * 5, days_with_reports: 20 });
    expect(body.trend.length).toBeGreaterThanOrEqual(30);
    expect(body.trend.at(-1)).toMatchObject({ total: 0 }); // today's report has not arrived: a zero day, not a hole

    const ips = body.senders.map((s: any) => s.source_ip);
    expect(ips).toEqual(['209.85.220.41', '198.2.180.1', '203.0.113.9', '167.89.1.1']); // by volume
    const mc = body.senders.find((s: any) => s.source_ip === '198.2.180.1');
    expect(mc).toMatchObject({ provider: { name: 'Mailchimp' }, messages: 240, spf_aligned_pct: 0, dkim_aligned_pct: 0, dmarc_pass_pct: 0, is_new: false });
    const sg = body.senders.find((s: any) => s.source_ip === '167.89.1.1');
    expect(sg).toMatchObject({ provider: { name: 'SendGrid' }, is_new: true, dmarc_pass_pct: 100, spf_aligned_pct: 100 });

    expect(body.fixes[0]).toMatchObject({ kind: 'authorize-sender', domain: 'acme.com', sender: { name: 'Mailchimp' } });
    expect(body.fixes[0].title).toMatch(/^Mailchimp sends \d+(\.\d)?% of your mail and fails DMARC$/);
    // Lookup failed (stubbed): we fall back to the stored policy and say so, rather than claiming "no record".
    expect(body.readiness).toMatchObject({ policy_source: 'stored', current: { policy: 'none' }, next: { policy: 'quarantine', testing: true } });
    expect(['ready', 'caution', 'blocked']).toContain(body.readiness.status);
  });

  it('uses the live record when it is readable', async () => {
    const t = await world();
    const tenant = makeTenant({ db: t.db, accountId: 'acct_default' });
    const res = await handleAnalyticsRoutes(new Request('https://x.test/api/domains/' + t.id + '/analytics'), tenant, {
      lookupDmarc: async () => 'v=DMARC1; p=quarantine; t=y; rua=mailto:rua@r.test',
    });
    const body = await res!.json() as any;
    expect(body.readiness).toMatchObject({ policy_source: 'dns', current: { policy: 'quarantine', testing: true }, next: { policy: 'quarantine', testing: false } });
    const none = await handleAnalyticsRoutes(new Request('https://x.test/api/domains/' + t.id + '/analytics'), tenant, { lookupDmarc: async () => null });
    expect((await none!.json() as any).readiness.status).toBe('no_policy');
  });

  it('clamps the window and keeps advice on 30 days when the chart shows 7', async () => {
    const t = await world();
    const seven = await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics?days=7`, { key: t.owner })).json() as any;
    expect(seven.days).toBe(7);
    expect(seven.totals.days_with_reports).toBe(7);
    expect(seven.readiness.metrics).toMatchObject({ window_days: 30, days_with_reports: 20 });
    const wide = await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics?days=9999`, { key: t.owner })).json() as any;
    expect(wide.days).toBe(90);
    expect((await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics?days=abc`, { key: t.owner })).json() as any).days).toBe(30);
  });

  it('rejects bad ids and unknown domains, and needs a sign-in', async () => {
    const t = await world();
    expect((await call(t.env, 'GET', '/api/domains/abc/analytics', { key: t.owner })).status).toBe(400);
    expect((await call(t.env, 'GET', '/api/domains/999/analytics', { key: t.owner })).status).toBe(404);
    expect((await call(t.env, 'GET', `/api/domains/${t.id}/analytics`)).status).toBe(401);
  });

  it('is read-only: members can read it, nothing writes through it', async () => {
    const t = await world();
    const member = await inviteAndAccept(t.env, t.owner, 'member@example.com', 'member');
    expect((await call(t.env, 'GET', `/api/domains/${t.id}/analytics`, { key: member })).status).toBe(200);
    expect((await call(t.env, 'POST', `/api/domains/${t.id}/analytics`, { key: member, body: {} })).status).toBe(403);
    expect((await call(t.env, 'POST', `/api/domains/${t.id}/analytics`, { key: t.owner, body: {} })).status).toBe(405);
  });
});

describe('GET /api/analytics', () => {
  it('rolls the whole account up, with a readiness line per domain', async () => {
    const t = await world();
    const q = forAccount(t.db, 'acct_default');
    const quiet = Number((await q.domains.insert({ domain: 'quiet.org', rua_address: 'rua@r.test' })).meta.last_row_id);
    const body = await (await call(t.env, 'GET', '/api/analytics?days=30', { key: t.owner })).json() as any;

    expect(body.sender_count).toBe(4);
    expect(body.senders[0]).toMatchObject({ source_ip: '209.85.220.41', domains: ['acme.com'] });
    expect(body.fixes[0]).toMatchObject({ domain: 'acme.com', sender: { name: 'Mailchimp' } });
    const byName = Object.fromEntries(body.domains.map((d: any) => [d.domain, d]));
    expect(byName['acme.com']).toMatchObject({ messages: 1910, readiness: { policy_source: 'stored' } });
    expect(byName['quiet.org']).toMatchObject({ domain_id: quiet, messages: 0, pass_rate: null, readiness: { status: 'no_policy' } });
  });

  it('is empty, not an error, for an account without reports', async () => {
    const env = makeEnv(createMigratedD1(), {}) as any;
    const owner = await setupOwner(env);
    const body = await (await call(env, 'GET', '/api/analytics', { key: owner })).json() as any;
    expect(body).toMatchObject({ senders: [], fixes: [], domains: [], sender_count: 0, totals: { messages: 0, pass_rate: null } });
  });
});

describe('analytics queries', () => {
  it('returns one row per source and authenticated domain, windowed counts with whole-horizon first/last seen', async () => {
    const t = await world();
    const now = Math.floor(Date.now() / 1000);
    const q = forAccount(t.db, 'acct_default');
    const rows = await q.analytics.senderRows(t.id, Math.floor(now / 86400) * 86400 - 5 * 86400, Math.floor(now / 86400) * 86400 - 30 * 86400, now);
    const g = rows.find((r) => r.source_ip === '209.85.220.41')!;
    expect(g.messages).toBe(5 * 80); // days 1..5 only
    expect(g.advice_messages).toBe(20 * 80); // the 30-day advice window comes from the same pass
    expect(g.last_seen - g.first_seen).toBeGreaterThanOrEqual(18 * 86400); // but it was first seen ~20 days ago
    expect(await q.analytics.senderRows(t.id, now + 86400, now + 86400, now)).toEqual([]); // nothing in a future window
  });

  it('never reaches another account’s domain, even by id', async () => {
    const t = await world();
    t.db.sqlite.exec("INSERT INTO accounts (id, name) VALUES ('acct_b', 'B')");
    const now = Math.floor(Date.now() / 1000);
    const other = forAccount(t.db, 'acct_b');
    expect(await other.analytics.senderRows(t.id, 0, 0, now)).toEqual([]);
    expect(await other.analytics.trend(t.id, 0)).toEqual([]);
    expect(await other.analytics.earliestReport(t.id, now)).toBeNull();
    expect(await other.analytics.domainTotals(0)).toEqual([]);
    expect(await other.analytics.senderRows(null, 0, 0, now)).toEqual([]);
  });
});

describe('readiness parity with rollout-next', () => {
  const LIVE = [
    'v=DMARC1; p=none; rua=mailto:rua@r.test',
    'v=DMARC1; p=none; sp=reject',
    'v=DMARC1; p=quarantine; t=y',
    'v=DMARC1; p=quarantine; t=y; sp=reject',
    'v=DMARC1; p=quarantine; pct=25',
    'v=DMARC1; p=quarantine; pct=0',
    'v=DMARC1; p=quarantine',
    'v=DMARC1; p=reject; pct=50',
    'v=DMARC1; p=reject; t=y',
  ];

  it.each(LIVE)('offers the step rollout-next offers: %s', async (record) => {
    const t = await world();
    dns.dmarc = record;
    const next = await (await call(t.env, 'GET', `/api/domains/${t.id}/rollout-next`, { key: t.owner })).json() as any;
    const a = await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics`, { key: t.owner })).json() as any;
    expect(a.readiness.policy_source).toBe('dns');
    expect(a.readiness.current.step).toBe(next.current_step_index);
    expect(a.readiness.next ? { policy: a.readiness.next.policy, testing: a.readiness.next.testing } : null).toEqual(next.next_step);
    dns.dmarc = undefined;
  });

  it('with DNS down, a stored pct of 0 means testing mode: the next step is full quarantine, not reject;t=y', async () => {
    const t = await world();
    dns.dmarc = undefined;
    t.db.sqlite.prepare("UPDATE domains SET dmarc_policy = 'quarantine', dmarc_pct = 0 WHERE id = ?").run(t.id);
    const a = await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics`, { key: t.owner })).json() as any;
    expect(a.readiness).toMatchObject({ policy_source: 'stored', current: { policy: 'quarantine', testing: true }, next: { policy: 'quarantine', testing: false } });
  });

  it('the account-wide view reads the stored pct too', async () => {
    const t = await world();
    t.db.sqlite.prepare("UPDATE domains SET dmarc_policy = 'quarantine', dmarc_pct = 0 WHERE id = ?").run(t.id);
    const body = await (await call(t.env, 'GET', '/api/analytics', { key: t.owner })).json() as any;
    expect(body.domains[0].readiness.next).toMatchObject({ policy: 'quarantine', testing: false });
    t.db.sqlite.prepare("UPDATE domains SET dmarc_pct = 100 WHERE id = ?").run(t.id);
    const full = await (await call(t.env, 'GET', '/api/analytics', { key: t.owner })).json() as any;
    expect(full.domains[0].readiness.next).toMatchObject({ policy: 'reject', testing: true });
  });
});

describe('estimated alignment', () => {
  it('says relaxed and assumed when DNS is unreadable, and applies strict alignment from the published record', async () => {
    const t = await world();
    dns.dmarc = undefined;
    const relaxed = await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics`, { key: t.owner })).json() as any;
    expect(relaxed.alignment).toEqual({ spf: 'relaxed', dkim: 'relaxed', basis: 'assumed', estimated: true });
    const sg = (b: any) => b.senders.find((x: any) => x.source_ip === '167.89.1.1');
    expect(sg(relaxed).spf_aligned_pct).toBe(100); // spf domain em.acme.com is under acme.com
    dns.dmarc = 'v=DMARC1; p=none; aspf=s; adkim=r';
    const strict = await (await call(t.env, 'GET', `/api/domains/${t.id}/analytics`, { key: t.owner })).json() as any;
    expect(strict.alignment).toEqual({ spf: 'strict', dkim: 'relaxed', basis: 'dns', estimated: true });
    expect(sg(strict).spf_aligned_pct).toBe(0); // em.acme.com is not acme.com
    expect(sg(strict).dkim_aligned_pct).toBe(100);
    dns.dmarc = undefined;
    const account = await (await call(t.env, 'GET', '/api/analytics', { key: t.owner })).json() as any;
    expect(account.alignment).toMatchObject({ basis: 'assumed', estimated: true });
  });
});
