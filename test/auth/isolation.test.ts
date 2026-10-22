// Two hosted (MODE=saas) accounts, A and B, each signed up for real. Everything A can do —
// as a session or as an API key — must neither reveal nor change anything of B's, through
// every /api route. Table-driven, with a guard that fails when a route is added to the router
// without being added here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { ACCOUNT_OWNED_TABLES } from '@inbox-angel/db';
import { call, makeEnv } from './helpers';
import { createApiKey } from '../../src/auth/api-keys';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

/** Strings that exist only in B's data: none may ever appear in a response to A. */
const SECRETS = ['b-secret.example.com', 'B-Org-Secret', 'b-owner@example.com', 'b-member@example.com', 'b-invite-token', 'b-rua-secret', 'B-Spf-Secret', 'b-policy-id', 'b-secret-settings-value', '198.51.100.77'];

const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
  const signup = async (email: string) => {
    const r = await call(env, 'POST', '/api/auth/signup', { body: { name: email, email, password: 'password-123' } });
    expect(r.status).toBe(201);
    const { token } = await r.json() as { token: string };
    const m = rows(db, 'SELECT m.account_id, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0];
    return { token, accountId: m.account_id as string, userId: m.user_id as string };
  };
  const A = await signup('a-owner@example.com');
  const B = await signup('b-owner@example.com');
  expect(A.accountId).not.toBe(B.accountId);

  const keyA = (await createApiKey(db as any, { accountId: A.accountId, userId: A.userId, name: 'a' })).key;
  const keyB = await createApiKey(db as any, { accountId: B.accountId, userId: B.userId, name: 'b-key' });

  // A's own data (ids interleave with B's on purpose).
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, account_id) VALUES (1, 'a-own.example.com', 'rua@a.test', ?)").run(A.accountId);
  db.sqlite.prepare("INSERT INTO settings (account_id, key, value) VALUES (?, 'reports_domain', 'reports.a-own.example.com')").run(A.accountId); // A finished the wizard
  // B's data, in every account-owned table.
  const b = B.accountId;
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, account_id, is_default) VALUES (2, 'b-secret.example.com', 'b-rua-secret@reports.b.test', ?, 1)").run(b);
  db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, account_id) VALUES (10, 2, 'B-Org-Secret', 'r-b', 1700000000, 1700086400, 5, 3, 2, ?)").run(b);
  db.sqlite.prepare("INSERT INTO report_records (id, report_id, source_ip, count, disposition, dkim_result, spf_result, header_from, account_id) VALUES (100, 10, '198.51.100.77', 5, 'none', 'fail', 'fail', 'b-secret.example.com', ?)").run(b);
  db.sqlite.prepare("INSERT INTO tls_reports (id, domain_id, org_name, date_begin, date_end, account_id) VALUES (20, 2, 'B-Org-Secret', 1700000000, 1700086400, ?)").run(b);
  db.sqlite.prepare("INSERT INTO spf_flatten_config (domain_id, canonical_record, flattened_record, account_id) VALUES (2, 'v=spf1 include:B-Spf-Secret ~all', 'v=spf1 ip4:198.51.100.77 ~all', ?)").run(b);
  db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, account_id) VALUES (2, 'b-policy-id', ?)").run(b);
  db.sqlite.prepare("INSERT INTO monitor_subscriptions (id, email, domain, account_id) VALUES (30, 'b-member@example.com', 'b-secret.example.com', ?)").run(b);
  db.sqlite.prepare("INSERT INTO invites (token, email, role, invited_by, expires_at, account_id) VALUES ('b-invite-token', 'b-member@example.com', 'member', 'b-owner@example.com', 9999999999, ?)").run(b);
  db.sqlite.prepare("INSERT INTO audit_log (id, action, resource_name, account_id) VALUES (40, 'domain.add', 'b-secret.example.com', ?)").run(b);
  db.sqlite.prepare("INSERT INTO settings (account_id, key, value) VALUES (?, 'custom_value', 'b-secret-settings-value')").run(b);
  db.sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u-b-member', 'b-member@example.com', 'B Member')").run();
  db.sqlite.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, 'u-b-member', 'member')").run(b);

  return { db, env, A, B, keyA, keyB };
}

/** Everything B owns, across every account-owned table, as comparable JSON. */
function snapshotOf(db: any, accountId: string) {
  const tables = [...ACCOUNT_OWNED_TABLES].filter(t => t !== 'memberships' || true);
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = rows(db, `SELECT * FROM ${t} WHERE account_id = ? ORDER BY 1, 2`, accountId);
  out.users = rows(db, 'SELECT id, email FROM users WHERE id IN (SELECT user_id FROM memberships WHERE account_id = ?) ORDER BY id', accountId);
  return JSON.stringify(out);
}

type Kind = 'denied' | 'scoped';
interface Route { method: string; path: string; body?: unknown; kind: Kind; note?: string }

/**
 * `denied`: addresses B's resource by id/key/token — A must get a 4xx and nothing may change.
 * `scoped`: acts on "the caller's account" — A may succeed, but only ever on A's own data.
 */
const ROUTES: Route[] = [
  // domains
  { method: 'GET', path: '/api/domains', kind: 'scoped' },
  { method: 'POST', path: '/api/domains', body: { domain: 'b-secret.example.com' }, kind: 'denied', note: 'hostname already monitored by B' },
  { method: 'DELETE', path: '/api/domains/2', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/stats', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/reports?date=2023-11-14', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/sources', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/explore', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/anomalies', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/export', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/check-summary', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/dns-check', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/onboarding-status', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/rollout-next', kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/rollout-advance', body: {}, kind: 'denied' },
  { method: 'PUT', path: '/api/domains/2/set-default', body: {}, kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/wizard-state', kind: 'denied' },
  { method: 'PUT', path: '/api/domains/2/wizard-state', body: { step: 3 }, kind: 'denied' },
  { method: 'PATCH', path: '/api/domains/2/dmarc', body: { policy: 'reject' }, kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/apply-dmarc', body: { record: 'v=DMARC1; p=reject' }, kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/apply-spf', body: { record: 'v=spf1 -all' }, kind: 'denied' },
  { method: 'PATCH', path: '/api/domains/2/alerts', body: { alerts_enabled: false }, kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/monitor-subs', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/spf-flatten', kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/spf-flatten', body: {}, kind: 'denied' },
  { method: 'DELETE', path: '/api/domains/2/spf-flatten', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/spf-flatten/preview', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/mta-sts', kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/mta-sts', body: { mode: 'enforce' }, kind: 'denied' },
  { method: 'PUT', path: '/api/domains/2/mta-sts', body: { mode: 'enforce' }, kind: 'denied' },
  { method: 'DELETE', path: '/api/domains/2/mta-sts', kind: 'denied' },
  { method: 'GET', path: '/api/domains/2/mta-sts/policy', kind: 'denied' },
  { method: 'POST', path: '/api/domains/bulk-import', body: { domains: 'fresh-a.example.net' }, kind: 'scoped' },
  { method: 'GET', path: '/api/domains/ct-discover?domain=example.net', kind: 'scoped' },
  // reports & monitoring
  { method: 'GET', path: '/api/reports', kind: 'scoped' },
  { method: 'GET', path: '/api/reports/10', kind: 'denied' },
  { method: 'GET', path: '/api/check-results', kind: 'scoped' },
  { method: 'PATCH', path: '/api/monitor-subs/30', body: { active: false }, kind: 'denied' },
  // settings & setup (act on the caller's own account)
  { method: 'POST', path: '/api/settings/base-domain', body: { domain: 'fresh-a.example.net' }, kind: 'scoped' },
  { method: 'POST', path: '/api/settings/register-destination', body: { email: 'a@example.com' }, kind: 'scoped' },
  { method: 'POST', path: '/api/setup/email-routing', body: {}, kind: 'scoped' },
  { method: 'POST', path: '/api/setup/custom-domain', body: { domain: 'x.example.net' }, kind: 'scoped' },
  { method: 'GET', path: '/api/zones', kind: 'scoped' },
  { method: 'POST', path: '/api/spf-lookup-count', body: { record: 'v=spf1 -all' }, kind: 'scoped' },
  // team, audit, keys
  { method: 'GET', path: '/api/team', kind: 'scoped' },
  { method: 'POST', path: '/api/team/invite', body: { email: 'new-for-a@example.com' }, kind: 'scoped' },
  { method: 'DELETE', path: '/api/team/u-b-member', kind: 'denied' },
  { method: 'GET', path: '/api/audit-log', kind: 'scoped' },
  { method: 'GET', path: '/api/keys', kind: 'scoped' },
  { method: 'DELETE', path: '/api/keys/__B_KEY__', kind: 'denied' },
  { method: 'POST', path: '/api/keys/revoke-all', body: {}, kind: 'scoped' },
];

/** Public routes: no account, no account data. */
const PUBLIC = [/^\/api\/version$/, /^\/api\/check-sessions/, /^\/api\/monitor$/];

describe('two hosted accounts: A cannot reach B', () => {
  for (const credential of ['session', 'api key'] as const) {
    describe(`as A, by ${credential}`, () => {
      it('every /api route: no B data in any response, B’s data and audit trail unchanged, no Cloudflare call for B', async () => {
        const w = await world();
        const cf = new FakeCloudflare({ 'b-secret.example.com': { id: 'zone-b', accountId: 'cf-b' }, 'a-own.example.com': { id: 'zone-a', accountId: 'cf-a' } });
        stubCloudflare(cf);
        const key = credential === 'session' ? w.A.token : w.keyA;
        const before = snapshotOf(w.db, w.B.accountId);
        const failures: string[] = [];

        for (const r of ROUTES) {
          const path = r.path.replace('__B_KEY__', w.keyB.id);
          const res = await call(w.env, r.method, path, { key, body: r.body });
          const text = await res.text();
          const leaked = SECRETS.filter(s => text.includes(s));
          if (leaked.length) failures.push(`${r.method} ${r.path} → leaked ${leaked.join(', ')}`);
          if (r.kind === 'denied' && !(res.status >= 400 && res.status < 500)) failures.push(`${r.method} ${r.path} → ${res.status}, expected 4xx`);
          if (res.status === 401) failures.push(`${r.method} ${r.path} → 401 (A’s own credential rejected?)`);
        }

        expect(failures).toEqual([]);
        expect(snapshotOf(w.db, w.B.accountId)).toBe(before);
        expect(cf.calls.filter(c => c.zoneId === 'zone-b')).toEqual([]);
        // B's credentials still work (A revoking "all my keys" did not touch B's)
        expect(rows(w.db, 'SELECT revoked_at FROM api_keys WHERE id = ?', w.keyB.id)).toEqual([{ revoked_at: null }]);
      });

      it('A’s own account is still usable, and A’s writes land in A’s account', async () => {
        const w = await world();
        const key = credential === 'session' ? w.A.token : w.keyA;
        const list = await (await call(w.env, 'GET', '/api/domains', { key })).json() as any;
        expect(list.domains.map((d: any) => d.domain)).toEqual(['a-own.example.com']);
        const set = await call(w.env, 'POST', '/api/settings/base-domain', { key, body: { domain: 'fresh-a.example.net' } });
        expect(set.status).toBeLessThan(300);
        expect(rows(w.db, "SELECT account_id FROM settings WHERE key = 'base_domain'")).toEqual([{ account_id: w.A.accountId }]);
        const invite = await call(w.env, 'POST', '/api/team/invite', { key, body: { email: 'new-for-a@example.com' } });
        expect(invite.status).toBe(201);
        expect(rows(w.db, "SELECT account_id FROM invites WHERE email = 'new-for-a@example.com'")).toEqual([{ account_id: w.A.accountId }]);
        expect(rows(w.db, 'SELECT DISTINCT actor_email FROM audit_log WHERE account_id = ? AND id != 40', w.B.accountId).every(r => r.actor_email !== 'a-owner@example.com')).toBe(true); // A's activity never lands in B's trail
        expect(rows(w.db, 'SELECT COUNT(*) n FROM audit_log WHERE account_id = ?', w.A.accountId)[0].n).toBeGreaterThan(0);
        const team = await (await call(w.env, 'GET', '/api/team', { key })).json() as any;
        expect(team.users.map((u: any) => u.email)).toEqual(['a-owner@example.com']);
      });
    });
  }

  it('A cannot pick B with X-Account-Id (session); API keys ignore the header', async () => {
    const w = await world();
    const sess = await call(w.env, 'GET', '/api/domains', { key: w.A.token, headers: { 'x-account-id': w.B.accountId } });
    expect(sess.status).toBe(403);
    expect(await sess.text()).not.toContain('b-secret');
    const viaKey = await (await call(w.env, 'GET', '/api/domains', { key: w.keyA, headers: { 'x-account-id': w.B.accountId } })).json() as any;
    expect(viaKey.domains.map((d: any) => d.domain)).toEqual(['a-own.example.com']);
  });

  it('A’s credentials never resolve to B’s account, and B’s never to A’s', async () => {
    const w = await world();
    const { sessionAccountResolver } = await import('../../src/auth/resolver');
    const who = (key: string) => sessionAccountResolver(new Request('https://ia.example.com/api/domains', { headers: { 'x-api-key': key } }), w.env);
    expect(await who(w.A.token)).toMatchObject({ accountId: w.A.accountId });
    expect(await who(w.keyA)).toMatchObject({ accountId: w.A.accountId });
    expect(await who(w.B.token)).toMatchObject({ accountId: w.B.accountId });
    expect(await who(w.keyB.key)).toMatchObject({ accountId: w.B.accountId });
  });

  it('a member of B cannot act on A either, and a B-key listing shows only B’s keys', async () => {
    const w = await world();
    const mine = await (await call(w.env, 'GET', '/api/keys', { key: w.B.token })).json() as any;
    expect(mine.keys.map((k: any) => k.id)).toEqual([w.keyB.id]);
    const aDomain = await call(w.env, 'GET', '/api/domains/1/stats', { key: w.B.token });
    expect(aDomain.status).toBe(404);
  });

  it('public and plumbing routes expose nothing of B', async () => {
    const w = await world();
    const status = await (await call(w.env, 'GET', '/api/auth/status')).text(); // anonymous
    const anonCheck = await (await call(w.env, 'GET', '/api/check-results')).status;
    for (const s of SECRETS) expect(status).not.toContain(s);
    expect(anonCheck).toBe(401);
    // an anonymous visitor to a hosted instance sees no account's domains in status
    expect(JSON.parse(status)).toMatchObject({ has_domain: false, base_domain: null, custom_domain: null });
  });

  it('table covers every account-data route in the router (add new routes here)', () => {
    const src = readFileSync(join(__dirname, '../../src/api/router.ts'), 'utf8');
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = [...src.matchAll(/path === '(\/api\/[^']+)' && method === '(\w+)'/g)]
      .map(m => ({ method: m[2], label: m[1], pattern: new RegExp(`^${esc(m[1])}$`) }));
    const regex = [...src.matchAll(/path\.match\(\/\^(.+?)\$\/\)/g)].map(m => {
      const label = m[1].replace(/\\\//g, '/');
      return { method: '*', label, pattern: new RegExp('^' + label.replace(/\(\[\^\/\]\+\)|\(\\d\+\)/g, '[^/]+') + '$') };
    });
    const concrete = ROUTES.map(r => ({ method: r.method, path: r.path.split('?')[0].replace('__B_KEY__', 'k') }));
    expect(literal.length + regex.length).toBeGreaterThan(40); // the scan itself works
    const uncovered: string[] = [];
    for (const r of [...literal, ...regex]) {
      if (PUBLIC.some(re => re.test(r.label.replace(/\\\//g, '/')))) continue;
      const hit = concrete.some(c => r.pattern.test(c.path) && (r.method === '*' || r.method === c.method));
      if (!hit) uncovered.push(`${r.method} ${r.label}`);
    }
    expect(uncovered).toEqual([]);
  });
});
