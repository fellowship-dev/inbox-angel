// Hosted caps: workspaces one person may own, domains one workspace may hold. Self-host has none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanLimitError, forWorkspace } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from './world';
import { planLimitBody, planLimitResponse, planLimits } from '../../src/hosted/plan-limits';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: null, manual: true }),
}));

const json = async (r: Response) => await r.json() as any;
const nxdomain = () => vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 }));
beforeEach(nxdomain);
afterEach(() => vi.unstubAllGlobals());

describe('planLimits', () => {
  const saas = (extra: Record<string, string> = {}) => planLimits({ MODE: 'saas', ...extra });

  it('defaults to 5 workspaces and 10 domains in hosted mode', () => {
    expect(saas()).toEqual({ workspacesPerUser: 5, domainsPerWorkspace: 10 });
  });

  it('takes a positive integer, anything else keeps the default', () => {
    for (const bad of ['0', '-1', 'abc', '', ' ', '1.5', '1e3', '99999999999999999999']) {
      expect(saas({ MAX_WORKSPACES_PER_USER: bad, MAX_DOMAINS_PER_WORKSPACE: bad }), `value ${JSON.stringify(bad)}`).toEqual({ workspacesPerUser: 5, domainsPerWorkspace: 10 });
    }
    expect(saas({ MAX_WORKSPACES_PER_USER: '12', MAX_DOMAINS_PER_WORKSPACE: ' 3 ' })).toEqual({ workspacesPerUser: 12, domainsPerWorkspace: 3 });
  });

  it('has no caps when self-hosting, whatever the variables say', () => {
    expect(planLimits({ MAX_WORKSPACES_PER_USER: '1', MAX_DOMAINS_PER_WORKSPACE: '1' })).toBeNull();
    expect(planLimits({ MODE: 'selfhost', MAX_DOMAINS_PER_WORKSPACE: '1' })).toBeNull();
  });
});

describe('plan_limit response', () => {
  it('is a 403 with the sentence, the limit and a help_url only for an https BOOKING_URL', async () => {
    const res = planLimitResponse({ BOOKING_URL: 'https://cal.example.com/max' }, 'domains_per_workspace', 10);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This workspace has reached its limit of 10 domains.', code: 'plan_limit', limit: { kind: 'domains_per_workspace', max: 10 }, help_url: 'https://cal.example.com/max' });
    expect(planLimitBody({ BOOKING_URL: 'https://cal.example.com/max' }, 'workspaces_per_user', 5)).toMatchObject({ error: 'You have reached the limit of 5 workspaces you can own.', limit: { kind: 'workspaces_per_user', max: 5 } });
    expect(planLimitBody({ BOOKING_URL: 'http://cal.example.com/max' }, 'domains_per_workspace', 1).help_url).toBeNull();
    expect(planLimitBody({ BOOKING_URL: 'javascript:alert(1)' }, 'domains_per_workspace', 1).help_url).toBeNull();
    expect(planLimitBody({}, 'domains_per_workspace', 1).help_url).toBeNull();
  });
});

async function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const user = async (email: string) => {
    const token = await signupVerified(env, email);
    const r = rows('SELECT m.workspace_id, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0];
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', ?)").run(r.workspace_id, `reports.${email.split('@')[0]}.test`);
    return { token, ws: r.workspace_id as string, id: r.user_id as string };
  };
  const createWs = (who: { token: string }, name = 'Extra') => call(env, 'POST', '/api/workspaces', { key: who.token, body: { name } });
  const fill = (ws: string, n: number, prefix = 'f') => {
    for (let i = 0; i < n; i++) db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES (?, 'x', ?, 'txt')").run(`${prefix}${i}.example.com`, ws);
  };
  const liveDomains = (ws: string) => rows('SELECT COUNT(*) AS n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', ws)[0].n as number;
  return { db, env, rows, user, createWs, fill, liveDomains };
}

describe('workspaces per user', () => {
  it('refuses the workspace over the cap with 403 plan_limit, writing no workspace, membership or audit row', async () => {
    const w = await hosted({ BOOKING_URL: 'https://cal.example.com/max' });
    const a = await w.user('a@example.com'); // the sign-up workspace counts as 1
    for (let i = 0; i < 4; i++) expect((await w.createWs(a)).status).toBe(201); // 5 of 5
    const before = { ws: w.rows('SELECT * FROM workspaces'), m: w.rows('SELECT * FROM memberships'), audit: w.rows("SELECT * FROM audit_log WHERE action = 'workspace.created'") };
    const res = await w.createWs(a, 'One too many');
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'You have reached the limit of 5 workspaces you can own.', code: 'plan_limit', limit: { kind: 'workspaces_per_user', max: 5 }, help_url: 'https://cal.example.com/max' });
    expect({ ws: w.rows('SELECT * FROM workspaces'), m: w.rows('SELECT * FROM memberships'), audit: w.rows("SELECT * FROM audit_log WHERE action = 'workspace.created'") }).toEqual(before);
    expect(w.rows("SELECT * FROM workspaces WHERE name = 'One too many'")).toEqual([]);
  });

  it('allows the one just under the cap, and the cap is per person', async () => {
    const w = await hosted();
    const a = await w.user('a@example.com');
    const b = await w.user('b@example.com');
    for (let i = 0; i < 3; i++) expect((await w.createWs(a)).status).toBe(201); // 4 of 5
    const res = await w.createWs(a);
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ role: 'owner', member_count: 1 });
    expect((await w.createWs(a)).status).toBe(403);
    expect((await w.createWs(b)).status).toBe(201);
  });

  it('MAX_WORKSPACES_PER_USER overrides the default', async () => {
    const w = await hosted({ MAX_WORKSPACES_PER_USER: '2' });
    const a = await w.user('a@example.com');
    expect((await w.createWs(a)).status).toBe(201);
    const res = await w.createWs(a);
    expect(res.status).toBe(403);
    expect((await json(res)).limit.max).toBe(2);
  });

  it('memberships the person was only invited to do not count', async () => {
    const w = await hosted({ MAX_WORKSPACES_PER_USER: '2' });
    const a = await w.user('a@example.com');
    for (const [i, role] of ['admin', 'member', 'admin', 'member'].entries()) {
      w.db.sqlite.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(`ws_inv${i}`, `inv${i}`);
      w.db.sqlite.prepare('INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)').run(`ws_inv${i}`, a.id, role);
    }
    expect((await w.createWs(a)).status).toBe(201); // 2 of 2 owned, 4 invited
    expect((await w.createWs(a)).status).toBe(403);
  });

  it('five creates at once with room for one: exactly one succeeds', async () => {
    const w = await hosted();
    const a = await w.user('a@example.com');
    for (let i = 0; i < 3; i++) await w.createWs(a); // 4 of 5
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => w.createWs(a, `race${i}`)));
    expect(results.map(r => r.status).sort()).toEqual([201, 403, 403, 403, 403]);
    expect(w.rows("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'", a.id)[0].n).toBe(5);
    expect(w.rows("SELECT COUNT(*) AS n FROM workspaces WHERE name LIKE 'race%'")[0].n).toBe(1);
  });

  it('self-host: no cap, whatever the variables say', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MAX_WORKSPACES_PER_USER: '1', MAX_DOMAINS_PER_WORKSPACE: '1' });
    const owner = await setupOwner(env);
    for (let i = 0; i < 7; i++) expect((await call(env, 'POST', '/api/workspaces', { key: owner, body: { name: `w${i}` } })).status).toBe(201);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role = 'owner'").get()).toEqual({ n: 8 });
  });
});

describe('domains per workspace', () => {
  const add = (w: Awaited<ReturnType<typeof hosted>>, who: { token: string }, domain: string) => call(w.env, 'POST', '/api/domains', { key: who.token, body: { domain } });

  it('at the cap a new domain is refused before any claim exists; just under it is allowed', async () => {
    const w = await hosted({ BOOKING_URL: 'https://cal.example.com/max' });
    const a = await w.user('a@example.com');
    w.fill(a.ws, 9);
    expect((await add(w, a, 'under.example.org')).status).toBe(202); // a claim: 9 of 10
    w.fill(a.ws, 1, 'tenth');
    const res = await add(w, a, 'over.example.org');
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'This workspace has reached its limit of 10 domains.', code: 'plan_limit', limit: { kind: 'domains_per_workspace', max: 10 }, help_url: 'https://cal.example.com/max' });
    expect(w.rows("SELECT * FROM domain_claims WHERE domain = 'over.example.org'")).toEqual([]);
    expect(w.liveDomains(a.ws)).toBe(10);
  });

  it('a domain the workspace already has keeps working at the cap', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '2' });
    const a = await w.user('a@example.com');
    w.fill(a.ws, 2);
    const res = await add(w, a, 'f0.example.com');
    expect(res.status).toBe(200);
    expect((await json(res)).resumed).toBe(true);
  });

  it('MAX_DOMAINS_PER_WORKSPACE overrides the default', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '1' });
    const a = await w.user('a@example.com');
    w.fill(a.ws, 1);
    const res = await add(w, a, 'new.example.org');
    expect(res.status).toBe(403);
    expect((await json(res)).limit).toEqual({ kind: 'domains_per_workspace', max: 1 });
  });

  it('verifying a claim at the cap answers plan_limit and the claim stays pending', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '2' });
    const a = await w.user('a@example.com');
    w.fill(a.ws, 1);
    const { claim } = await json(await add(w, a, 'acme.org'));
    w.fill(a.ws, 1, 'late'); // the workspace fills up while the claim is waiting
    const proven = (host: string, txt: string) => vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      return new Response(JSON.stringify(u.searchParams.get('name') === host ? { Status: 0, Answer: [{ name: host, type: 16, TTL: 60, data: `"${txt}"` }] } : { Status: 3 }));
    });
    proven('_readysetmail.acme.org', claim.txt_value);
    const res = await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: a.token, body: {} });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('plan_limit');
    expect(w.rows("SELECT * FROM domains WHERE domain = 'acme.org'")).toEqual([]);
    expect(w.rows("SELECT status FROM domain_claims WHERE id = ?", claim.id)).toEqual([{ status: 'pending' }]);
  });

  it('the insert itself enforces the cap even when the advisory checks were passed (verify at 9 of 10, then 10 of 10)', async () => {
    const w = await hosted();
    const a = await w.user('a@example.com');
    w.fill(a.ws, 9);
    const { claim } = await json(await add(w, a, 'acme.org'));
    vi.stubGlobal('fetch', async (url: string) => {
      const name = new URL(url).searchParams.get('name');
      return new Response(JSON.stringify(name === '_readysetmail.acme.org' ? { Status: 0, Answer: [{ name, type: 16, TTL: 60, data: `"${claim.txt_value}"` }] } : { Status: 3 }));
    });
    expect((await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: a.token, body: {} })).status).toBe(201);
    expect(w.liveDomains(a.ws)).toBe(10);
  });

  it('parallel inserts at 9 of 10: exactly one lands, the others throw PlanLimitError and write nothing', async () => {
    const w = await hosted();
    const a = await w.user('a@example.com');
    w.fill(a.ws, 9);
    const q = forWorkspace(w.db as any, a.ws);
    const out = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => q.domains.insert({ domain: `race${i}.example.net`, rua_address: 'x', verified_via: 'txt' }, undefined, { maxDomains: 10 })));
    expect(out.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = out.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected).toHaveLength(4);
    expect(rejected.every(r => r.reason instanceof PlanLimitError && r.reason.max === 10)).toBe(true);
    expect(w.liveDomains(a.ws)).toBe(10);
  });

  it('evicted domains do not count against the cap', async () => {
    const w = await hosted();
    const a = await w.user('a@example.com');
    w.fill(a.ws, 10);
    w.db.sqlite.prepare("UPDATE domains SET evicted_at = 1 WHERE domain = 'f0.example.com'").run();
    await forWorkspace(w.db as any, a.ws).domains.insert({ domain: 'room.example.net', rua_address: 'x' }, undefined, { maxDomains: 10 });
    expect(w.liveDomains(a.ws)).toBe(10);
  });

  it('base domain: refused at the cap with no domain row and no settings written; an existing domain still applies', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '2' });
    const a = await w.user('a@example.com');
    w.fill(a.ws, 2);
    const settingsBefore = w.rows('SELECT * FROM settings ORDER BY workspace_id, key');

    const q = forWorkspace(w.db as any, a.ws);
    const arg = { domain: 'hub.example.net', rua_address: 'rua@reports.hub.example.net', verified_via: 'txt', settings: { base_domain: 'hub.example.net', reports_domain: 'reports.hub.example.net' } };
    await expect(q.baseDomain.apply(arg, { maxDomains: 2 })).rejects.toBeInstanceOf(PlanLimitError);
    expect(w.rows("SELECT * FROM domains WHERE domain = 'hub.example.net'")).toEqual([]);
    expect(w.rows('SELECT * FROM settings ORDER BY workspace_id, key')).toEqual(settingsBefore);

    // an existing domain at the cap is not a new one: its settings are written
    const existing = { ...arg, domain: 'f0.example.com', settings: { base_domain: 'f0.example.com' } };
    expect(await q.baseDomain.apply(existing, { maxDomains: 2 })).toBeNull();
    expect(w.rows("SELECT value FROM settings WHERE workspace_id = ? AND key = 'base_domain'", a.ws)).toEqual([{ value: 'f0.example.com' }]);

    // under the cap the domain and its settings land together
    const room = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '2' });
    const b = await room.user('b@example.com');
    const id = await forWorkspace(room.db as any, b.ws).baseDomain.apply(arg, { maxDomains: 2 });
    expect(id).toBeGreaterThan(0);
    expect(room.rows("SELECT value FROM settings WHERE workspace_id = ? AND key = 'base_domain'", b.ws)).toEqual([{ value: 'hub.example.net' }]);
  });

  it('base-domain route: 403 plan_limit before any claim is created', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '1' });
    const a = await w.user('a@example.com');
    w.fill(a.ws, 1);
    const res = await call(w.env, 'POST', '/api/settings/base-domain', { key: a.token, body: { domain: 'hub.example.net' } });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('plan_limit');
    expect(w.rows("SELECT * FROM domain_claims WHERE domain = 'hub.example.net'")).toEqual([]);
  });

  it('bulk import stops at the cap: later rows are plan_limit and not attempted', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '3' });
    const a = await w.user('a@example.com');
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(a.ws);
    w.fill(a.ws, 1); // 2 of 3
    // Subdomains of a verified domain are proven by their parent: they insert (and count) without a claim.
    const res = await call(w.env, 'POST', '/api/domains/bulk-import', { key: a.token, body: { domains: 'one.acme.com\ntwo.acme.com\nthree.acme.com\nbad domain\nf0.example.com\nother.example.org' } });
    const body = await json(res);
    expect(body.results.map((r: any) => [r.domain, r.status, r.code])).toEqual([
      ['one.acme.com', 'imported', undefined],
      ['two.acme.com', 'error', 'plan_limit'],
      ['three.acme.com', 'error', 'plan_limit'],
      ['bad domain', 'invalid', undefined],
      ['f0.example.com', 'duplicate', undefined],
      ['other.example.org', 'error', 'plan_limit'],
    ]);
    expect(body.results[1].error).toBe('This workspace has reached its limit of 3 domains.');
    expect(w.liveDomains(a.ws)).toBe(3);
    expect(w.rows('SELECT * FROM domain_claims')).toEqual([]);
  });

  it('self-host: more than 10 domains and no plan_limit', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MAX_DOMAINS_PER_WORKSPACE: '1' });
    const owner = await setupOwner(env);
    for (let i = 0; i < 12; i++) expect((await call(env, 'POST', '/api/domains', { key: owner, body: { domain: `s${i}.example.com` } })).status).toBe(201);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM domains').get()).toEqual({ n: 12 });
  });
});
