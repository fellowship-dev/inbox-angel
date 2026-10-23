// Two hosted (MODE=saas) workspaces, A and B, each signed up for real. Everything A can do —
// as a session or as an API key — must neither reveal nor change anything of B's, through
// every /api route. Table-driven, with a guard that fails when a route is added to the router
// without being added here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { WORKSPACE_OWNED_TABLES } from '@inbox-angel/db';
import { call, makeEnv } from './helpers';
import { createApiKey } from '../../src/auth/api-keys';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { HOSTED_ENV } from '../hosted/world';
import { AUTH } from '../connections/mock-oauth';
import { KEY, Z } from '../connections/world';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

/** Strings that exist only in B's data: none may ever appear in a response to A. */
const SECRETS = ['b-secret.example.com', 'B-Org-Secret', 'b-owner@example.com', 'b-member@example.com', 'b-invite-token', 'b-rua-secret', 'B-Spf-Secret', 'b-policy-id', 'b-secret-settings-value', '198.51.100.77', 'b-hosted-id-secret', 'b-intake-hash-secret', 'b-cf-label-secret', 'b-cf-envelope-secret', 'b-cf-account-secret', 'b-zone-secret.example.org', 'cfc_b_secret'];

const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, ...AUTH, TOKEN_ENCRYPTION_KEY: `k1:${KEY}` });
  const signup = async (email: string) => {
    const r = await call(env, 'POST', '/api/auth/signup', { body: { name: email, email, password: 'password-123' } });
    expect(r.status).toBe(201);
    const { token } = await r.json() as { token: string };
    const m = rows(db, 'SELECT m.workspace_id, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0];
    return { token, workspaceId: m.workspace_id as string, userId: m.user_id as string };
  };
  const A = await signup('a-owner@example.com');
  const B = await signup('b-owner@example.com');
  expect(A.workspaceId).not.toBe(B.workspaceId);

  const keyA = (await createApiKey(db as any, { workspaceId: A.workspaceId, userId: A.userId, name: 'a' })).key;
  const keyB = await createApiKey(db as any, { workspaceId: B.workspaceId, userId: B.userId, name: 'b-key' });

  // A's own data (ids interleave with B's on purpose).
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id) VALUES (1, 'a-own.example.com', 'rua@a.test', ?)").run(A.workspaceId);
  db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', 'reports.a-own.example.com')").run(A.workspaceId); // A finished the wizard
  // B's data, in every workspace-owned table.
  const b = B.workspaceId;
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id, is_default) VALUES (2, 'b-secret.example.com', 'b-rua-secret@reports.b.test', ?, 1)").run(b);
  db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id) VALUES (10, 2, 'B-Org-Secret', 'r-b', 1700000000, 1700086400, 5, 3, 2, ?)").run(b);
  db.sqlite.prepare("INSERT INTO report_records (id, report_id, source_ip, count, disposition, dkim_result, spf_result, header_from, workspace_id) VALUES (100, 10, '198.51.100.77', 5, 'none', 'fail', 'fail', 'b-secret.example.com', ?)").run(b);
  // A recent report too: the analytics endpoints only look back 180 days, and these must be able to leak if they ever scope wrongly.
  const recent = Math.floor(Date.now() / 1000) - 2 * 86400;
  db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id) VALUES (11, 2, 'B-Org-Secret', 'r-b-recent', ?, ?, 5, 0, 5, ?)").run(recent, recent + 86399, b);
  db.sqlite.prepare("INSERT INTO report_records (id, report_id, source_ip, count, disposition, dkim_result, spf_result, header_from, workspace_id) VALUES (101, 11, '198.51.100.77', 5, 'none', 'fail', 'fail', 'b-secret.example.com', ?)").run(b);
  db.sqlite.prepare("INSERT INTO tls_reports (id, domain_id, org_name, date_begin, date_end, workspace_id) VALUES (20, 2, 'B-Org-Secret', 1700000000, 1700086400, ?)").run(b);
  db.sqlite.prepare("INSERT INTO spf_flatten_config (domain_id, canonical_record, flattened_record, workspace_id) VALUES (2, 'v=spf1 include:B-Spf-Secret ~all', 'v=spf1 ip4:198.51.100.77 ~all', ?)").run(b);
  db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id) VALUES (2, 'b-policy-id', ?)").run(b);
  db.sqlite.prepare("INSERT INTO monitor_subscriptions (id, email, domain, workspace_id) VALUES (30, 'b-member@example.com', 'b-secret.example.com', ?)").run(b);
  db.sqlite.prepare("INSERT INTO invites (token, email, role, invited_by, expires_at, workspace_id) VALUES ('b-invite-token', 'b-member@example.com', 'member', 'b-owner@example.com', 9999999999, ?)").run(b);
  db.sqlite.prepare("INSERT INTO audit_log (id, action, resource_name, workspace_id) VALUES (40, 'domain.add', 'b-secret.example.com', ?)").run(b);
  db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'custom_value', 'b-secret-settings-value')").run(b);
  db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key, dmarc_record_id) VALUES (2, ?, 'b-hosted-id-secret', 'z1', 'rec-b')").run(b);
  db.sqlite.prepare("INSERT INTO intake_tokens (domain_id, workspace_id, token_hash) VALUES (2, ?, 'b-intake-hash-secret')").run(b);
  db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, cf_account_id, cf_account_name, auth_type, token_envelope, scopes) VALUES ('cfc_b_secret', ?, 'b-cf-label-secret', 'b-cf-account-secret', 'b-cf-account-secret', 'oauth', 'ia1.k1.b-cf-envelope-secret.b-cf-envelope-secret', 'zone:read')").run(b);
  db.sqlite.prepare("INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name, cf_account_id) VALUES ('cfc_b_secret', ?, ?, 'b-zone-secret.example.org', 'b-cf-account-secret')").run(b, Z.b);
  db.sqlite.prepare("UPDATE domains SET cf_connection_id = 'cfc_b_secret' WHERE id = 2").run();
  db.sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u-b-member', 'b-member@example.com', 'B Member')").run();
  db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, 'u-b-member', 'member')").run(b);

  return { db, env, A, B, keyA, keyB };
}

/** Everything B owns, across every workspace-owned table, as comparable JSON. */
function snapshotOf(db: any, workspaceId: string) {
  const tables = [...WORKSPACE_OWNED_TABLES].filter(t => t !== 'memberships' || true);
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = rows(db, `SELECT * FROM ${t} WHERE workspace_id = ? ORDER BY 1, 2`, workspaceId);
  out.users = rows(db, 'SELECT id, email FROM users WHERE id IN (SELECT user_id FROM memberships WHERE workspace_id = ?) ORDER BY id', workspaceId);
  return JSON.stringify(out);
}

type Kind = 'denied' | 'scoped';
interface Route { method: string; path: string; body?: unknown; kind: Kind; note?: string }

/**
 * `denied`: addresses B's resource by id/key/token — A must get a 4xx and nothing may change.
 * `scoped`: acts on "the caller's workspace" — A may succeed, but only ever on A's own data.
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
  // hosted records (MODE=saas): src/hosted/routes.ts
  { method: 'GET', path: '/api/domains/2/hosted', kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/hosted', body: { mta_sts: true }, kind: 'denied' },
  { method: 'DELETE', path: '/api/domains/2/hosted', kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/hosted/rotate-token', body: {}, kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/hosted/verify', body: {}, kind: 'denied' },
  { method: 'GET', path: '/api/domains/1/hosted', kind: 'scoped' },
  // analytics (src/analytics/routes.ts): read-only rollups of the caller's own reports
  { method: 'GET', path: '/api/analytics?days=90', kind: 'scoped' },
  { method: 'GET', path: '/api/domains/1/analytics', kind: 'scoped' },
  { method: 'GET', path: '/api/domains/2/analytics?days=90', kind: 'denied' },
  { method: 'POST', path: '/api/domains/2/analytics', body: {}, kind: 'denied', note: 'no write verb exists; must not reach B either' },
  // Cloudflare connections (src/connections/routes.ts): owner/admin, the caller's own workspace only
  { method: 'GET', path: '/api/cloudflare/connections', kind: 'scoped' },
  { method: 'POST', path: '/api/cloudflare/connections', body: { token: 'a-pasted-token-0123456789abcdef' }, kind: 'scoped' },
  { method: 'GET', path: '/api/cloudflare/connections/cfc_b_secret', kind: 'denied' },
  { method: 'DELETE', path: '/api/cloudflare/connections/cfc_b_secret', kind: 'denied' },
  { method: 'PUT', path: '/api/cloudflare/connections/cfc_b_secret/token', body: { token: 'a-evil-token-0123456789abcdef' }, kind: 'denied' },
  { method: 'GET', path: '/api/cloudflare/connections/cfc_b_secret/zones', kind: 'denied' },
  { method: 'PUT', path: '/api/cloudflare/connections/cfc_b_secret/zones', body: { zone_ids: [Z.a1] }, kind: 'denied' },
  { method: 'POST', path: '/api/cloudflare/oauth/start', body: {}, kind: 'scoped' },
  { method: 'POST', path: '/api/cloudflare/oauth/start', body: { connection_id: 'cfc_b_secret' }, kind: 'denied', note: 'reconnecting B\'s connection' },
  { method: 'GET', path: '/api/cloudflare/oauth/callback?code=x&state=y', kind: 'scoped', note: 'no cookie: refused, whatever the state' },
  { method: 'PUT', path: '/api/domains/2/connection', body: { connection_id: null }, kind: 'denied', note: 'B\'s domain' },
  { method: 'PUT', path: '/api/domains/1/connection', body: { connection_id: 'cfc_b_secret' }, kind: 'denied', note: 'A\'s domain, B\'s connection' },
  { method: 'PUT', path: '/api/domains/1/connection', body: { connection_id: null }, kind: 'scoped' },
  { method: 'GET', path: '/api/hosted/config', kind: 'scoped' },
  { method: 'POST', path: '/api/domains/bulk-import', body: { domains: 'fresh-a.example.net' }, kind: 'scoped' },
  { method: 'GET', path: '/api/domains/ct-discover?domain=example.net', kind: 'scoped' },
  // reports & monitoring
  { method: 'GET', path: '/api/reports', kind: 'scoped' },
  { method: 'GET', path: '/api/reports/10', kind: 'denied' },
  { method: 'GET', path: '/api/check-results', kind: 'scoped' },
  { method: 'PATCH', path: '/api/monitor-subs/30', body: { active: false }, kind: 'denied' },
  // settings & setup (act on the caller's own workspace)
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
  { method: 'GET', path: '/api/me', kind: 'scoped' },
  { method: 'GET', path: '/api/keys', kind: 'scoped' },
  { method: 'DELETE', path: '/api/keys/__B_KEY__', kind: 'denied' },
  { method: 'POST', path: '/api/keys/revoke-all', body: {}, kind: 'scoped' },
];

/** Public routes: no workspace, no workspace data. */
const PUBLIC = [/^\/api\/version$/, /^\/api\/check-sessions/, /^\/api\/monitor$/];

describe('two hosted workspaces: A cannot reach B', () => {
  for (const credential of ['session', 'api key'] as const) {
    describe(`as A, by ${credential}`, () => {
      it('every /api route: no B data in any response, B’s data and audit trail unchanged, no Cloudflare call for B', async () => {
        const w = await world();
        const cf = new FakeCloudflare({ 'b-secret.example.com': { id: 'zone-b', cfAccountId: 'cf-b' }, 'a-own.example.com': { id: 'zone-a', cfAccountId: 'cf-a' } });
        stubCloudflare(cf);
        const key = credential === 'session' ? w.A.token : w.keyA;
        const before = snapshotOf(w.db, w.B.workspaceId);
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
        expect(snapshotOf(w.db, w.B.workspaceId)).toBe(before);
        expect(cf.calls.filter(c => c.zoneId === 'zone-b')).toEqual([]);
        // B's credentials still work (A revoking "all my keys" did not touch B's)
        expect(rows(w.db, 'SELECT revoked_at FROM api_keys WHERE id = ?', w.keyB.id)).toEqual([{ revoked_at: null }]);
      });

      it('A’s own workspace is still usable, and A’s writes land in A’s workspace', async () => {
        const w = await world();
        const key = credential === 'session' ? w.A.token : w.keyA;
        const list = await (await call(w.env, 'GET', '/api/domains', { key })).json() as any;
        expect(list.domains.map((d: any) => d.domain)).toEqual(['a-own.example.com']);
        const set = await call(w.env, 'POST', '/api/settings/base-domain', { key, body: { domain: 'fresh-a.example.net' } });
        expect(set.status).toBeLessThan(300);
        expect(rows(w.db, "SELECT workspace_id FROM settings WHERE key = 'base_domain'")).toEqual([{ workspace_id: w.A.workspaceId }]);
        const invite = await call(w.env, 'POST', '/api/team/invite', { key, body: { email: 'new-for-a@example.com' } });
        expect(invite.status).toBe(201);
        expect(rows(w.db, "SELECT workspace_id FROM invites WHERE email = 'new-for-a@example.com'")).toEqual([{ workspace_id: w.A.workspaceId }]);
        expect(rows(w.db, 'SELECT DISTINCT actor_email FROM audit_log WHERE workspace_id = ? AND id != 40', w.B.workspaceId).every(r => r.actor_email !== 'a-owner@example.com')).toBe(true); // A's activity never lands in B's trail
        expect(rows(w.db, 'SELECT COUNT(*) n FROM audit_log WHERE workspace_id = ?', w.A.workspaceId)[0].n).toBeGreaterThan(0);
        const team = await (await call(w.env, 'GET', '/api/team', { key })).json() as any;
        expect(team.users.map((u: any) => u.email)).toEqual(['a-owner@example.com']);
      });
    });
  }

  it('A cannot pick B with X-Workspace-Id (session); API keys ignore the header', async () => {
    const w = await world();
    const sess = await call(w.env, 'GET', '/api/domains', { key: w.A.token, headers: { 'x-workspace-id': w.B.workspaceId } });
    expect(sess.status).toBe(403);
    expect(await sess.text()).not.toContain('b-secret');
    const viaKey = await (await call(w.env, 'GET', '/api/domains', { key: w.keyA, headers: { 'x-workspace-id': w.B.workspaceId } })).json() as any;
    expect(viaKey.domains.map((d: any) => d.domain)).toEqual(['a-own.example.com']);
  });

  it('A’s credentials never resolve to B’s workspace, and B’s never to A’s', async () => {
    const w = await world();
    const { sessionWorkspaceResolver } = await import('../../src/auth/resolver');
    const who = (key: string) => sessionWorkspaceResolver(new Request('https://ia.example.com/api/domains', { headers: { 'x-api-key': key } }), w.env);
    expect(await who(w.A.token)).toMatchObject({ workspaceId: w.A.workspaceId });
    expect(await who(w.keyA)).toMatchObject({ workspaceId: w.A.workspaceId });
    expect(await who(w.B.token)).toMatchObject({ workspaceId: w.B.workspaceId });
    expect(await who(w.keyB.key)).toMatchObject({ workspaceId: w.B.workspaceId });
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
    // an anonymous visitor to a hosted instance sees no workspace's domains in status
    expect(JSON.parse(status)).toMatchObject({ has_domain: false, base_domain: null, custom_domain: null });
  });

  it('table covers every route of the hosted-records module (add new routes here)', () => {
    const src = readFileSync(join(__dirname, '../../src/hosted/routes.ts'), 'utf8');
    const documented = [...src.matchAll(/^\/\/\s+(GET|POST|PUT|DELETE)\s+(\/api\/\S+)/gm)].map(m => `${m[1]} ${m[2].replace(':id', '2')}`);
    expect(documented.length).toBe(5);
    const covered = ROUTES.filter(r => r.kind === 'denied').map(r => `${r.method} ${r.path}`);
    expect(documented.filter(d => !covered.includes(d))).toEqual([]);
  });

  it('table covers every route of the analytics module (add new routes here)', () => {
    const src = readFileSync(join(__dirname, '../../src/analytics/routes.ts'), 'utf8');
    const documented = [...src.matchAll(/^\/\/\s+GET\s+(\/api\/[^?\s]+)/gm)].map(m => `GET ${m[1].replace(':id', '2')}`);
    expect(documented).toEqual(['GET /api/analytics', 'GET /api/domains/2/analytics']);
    const covered = ROUTES.map(r => `${r.method} ${r.path.split('?')[0]}`);
    expect(documented.filter(d => !covered.includes(d))).toEqual([]);
    expect(ROUTES.some(r => r.kind === 'denied' && r.path.startsWith('/api/domains/2/analytics'))).toBe(true);
  });

  it('table covers every route of the connections module (add new routes here)', () => {
    const src = readFileSync(join(__dirname, '../../src/connections/routes.ts'), 'utf8');
    const documented = [...src.matchAll(/^\/\/\s+(GET|POST|PUT|DELETE)\s+(\/api\/\S+)/gm)]
      .map(m => `${m[1]} ${m[2].replace('/domains/:id', '/domains/2').replace('/connections/:id', '/connections/cfc_b_secret')}`);
    expect(documented.length).toBe(10);
    const covered = ROUTES.map(r => `${r.method} ${r.path.split('?')[0]}`);
    expect(documented.filter(d => !covered.includes(d))).toEqual([]);
    // every module route that takes an id is also exercised against B's id
    const denied = ROUTES.filter(r => r.kind === 'denied').map(r => `${r.method} ${r.path.split('?')[0]}`);
    expect(documented.filter(d => /cfc_b_secret|domains\/2/.test(d) && !denied.includes(d))).toEqual([]);
  });

  it('analytics shows each workspace only its own senders (B sees its own, A sees none of them)', async () => {
    const w = await world();
    const own = await (await call(w.env, 'GET', '/api/analytics', { key: w.B.token })).text();
    expect(own).toContain('198.51.100.77'); // control: the secret really is in B's rollup, so its absence for A means something
    for (const key of [w.A.token, w.keyA]) {
      const mine = await (await call(w.env, 'GET', '/api/analytics?days=90', { key })).text();
      for (const s of SECRETS) expect(mine).not.toContain(s);
    }
  });

  it('hosted intake: A’s token cannot file or reveal anything in B (see test/hosted/intake.test.ts for the report-level checks)', async () => {
    const w = await world();
    const res = await call(w.env, 'GET', '/api/domains/1/hosted', { key: w.A.token });
    expect(JSON.stringify(await res.json())).not.toMatch(/b-hosted-id-secret|b-intake-hash-secret/);
  });

  it('table covers every workspace-data route in the router (add new routes here)', () => {
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
