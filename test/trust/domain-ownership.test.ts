// Domain ownership proof (SaaS): a domain is a pending claim until its owner is proven. Pending claims show no
// reports, check results or stats, trigger no DNS writes, and never block another workspace.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, signupVerified, setupOwner } from '../auth/helpers';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { HOSTED_ENV } from '../hosted/world';
import { ConnectionService } from '../../src/connections/service';

const json = async (r: Response) => await r.json() as any;
afterEach(() => vi.restoreAllMocks());

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const mk = async (email: string, reports: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', ?)").run(ws, reports);
    return { token, ws };
  };
  const A = await mk('a@example.com', 'reports.a.test');
  const B = await mk('b@example.com', 'reports.b.test');
  const cf = stubCloudflare(new FakeCloudflare({}));
  return { db, env, rows, A, B, cf };
}

const add = (w: Awaited<ReturnType<typeof world>>, who: { token: string }, domain: string) =>
  call(w.env, 'POST', '/api/domains', { key: who.token, body: { domain } });

describe('a claimed domain stays pending until ownership is proven', () => {
  it('creates only a claim: no domain row, no monitor subscription, no Cloudflare or DNS write', async () => {
    const w = await world();
    w.cf.calls.length = 0;
    const res = await add(w, w.A, 'acme.com');
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ pending: true, domain: null, claim: { domain: 'acme.com', status: 'pending', txt_name: '_inboxangel.acme.com' } });
    expect(body.claim.txt_value).toMatch(/^inboxangel-verify=[0-9a-f]{32}$/);
    expect(w.rows("SELECT * FROM domains WHERE domain = 'acme.com'")).toEqual([]);
    expect(w.rows('SELECT * FROM monitor_subscriptions')).toEqual([]);
    expect(w.cf.calls).toEqual([]);

    const list = await json(await call(w.env, 'GET', '/api/domains', { key: w.A.token }));
    expect(list.domains).toEqual([]);
    expect(list.pending_claims).toMatchObject([{ domain: 'acme.com', status: 'pending' }]);
  });

  it('shows no reports, stats, check results or hosted records for it, and cannot be enabled for hosting', async () => {
    const w = await world();
    const { claim } = await json(await add(w, w.A, 'acme.com'));
    w.db.sqlite.prepare("INSERT INTO check_results (from_email, from_domain, overall_status) VALUES ('someone@acme.com', 'acme.com', 'exposed')").run();
    expect((await json(await call(w.env, 'GET', '/api/check-results', { key: w.A.token }))).results).toEqual([]);
    for (const p of ['stats', 'sources', 'reports?date=2026-01-01', 'hosted', 'analytics']) {
      expect((await call(w.env, 'GET', `/api/domains/${claim.id}/${p}`, { key: w.A.token })).status).toBeGreaterThanOrEqual(400);
    }
    expect((await call(w.env, 'POST', `/api/domains/${claim.id}/hosted`, { key: w.A.token, body: {} })).status).toBeGreaterThanOrEqual(400);
    expect(w.rows('SELECT * FROM hosted_domains')).toEqual([]);
    expect((await json(await call(w.env, 'GET', '/api/reports', { key: w.A.token }))).reports).toEqual([]);
  });

  it('is not blocked by another workspace’s pending claim: several claims on one name coexist', async () => {
    const w = await world();
    expect((await add(w, w.A, 'acme.com')).status).toBe(202);
    expect((await add(w, w.B, 'acme.com')).status).toBe(202);
    const [a, b] = [w.A, w.B].map(x => w.rows('SELECT token FROM domain_claims WHERE workspace_id = ?', x.ws)[0].token);
    expect(a).not.toBe(b); // each claim has its own token
    // asking again returns the same claim (instructions stay valid)
    const again = await json(await add(w, w.A, 'acme.com'));
    expect(again.claim.txt_value).toBe(`inboxangel-verify=${a}`);
    expect(w.rows('SELECT * FROM domain_claims')).toHaveLength(2);
  });

  it('verifies with the TXT record holding this claim’s token, and only then', async () => {
    const w = await world();
    const { claim } = await json(await add(w, w.A, 'acme.com'));
    const verify = () => call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: w.A.token, body: {} });

    let res = await verify();
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/not found yet/);
    expect(w.rows("SELECT last_error FROM domain_claims WHERE id = ?", claim.id)[0].last_error).toMatch(/not found/);

    w.cf.doh['_inboxangel.acme.com'] = ['inboxangel-verify=' + 'f'.repeat(32)]; // someone else's token
    expect((await verify()).status).toBe(422);
    expect(w.rows("SELECT * FROM domains WHERE domain = 'acme.com'")).toEqual([]);

    w.cf.doh['_inboxangel.acme.com'] = [claim.txt_value];
    res = await verify();
    expect(res.status).toBe(201);
    expect(w.rows("SELECT workspace_id, verified_via FROM domains WHERE domain = 'acme.com'")).toEqual([{ workspace_id: w.A.ws, verified_via: 'txt' }]);
    expect(w.rows('SELECT * FROM domain_claims WHERE workspace_id = ?', w.A.ws)).toEqual([]);
  });

  it('proves and resumes a domain without configuring an intake hub', async () => {
    const w = await world();
    w.db.sqlite.prepare("DELETE FROM settings WHERE workspace_id = ?").run(w.A.ws);
    const { claim } = await json(await add(w, w.A, 'fresh.example'));
    w.cf.doh['_inboxangel.fresh.example'] = [claim.txt_value];
    const verified = await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: w.A.token, body: {} });
    expect(verified.status).toBe(201);
    const body = await json(verified);
    expect(body.intake).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    expect(body.domain.rua_address).toBe('');
    const repeated = await add(w, w.A, 'fresh.example');
    expect(repeated.status).toBe(200);
    expect((await json(repeated)).domain.id).toBe(body.domain.id);
    expect(w.rows("SELECT * FROM domains WHERE domain = 'fresh.example'")).toHaveLength(1);
    expect(w.rows('SELECT * FROM domain_claims WHERE workspace_id = ?', w.A.ws)).toEqual([]);
  });

  it('first to verify wins: the other pending claims are told, cannot verify, and cannot re-claim', async () => {
    const w = await world();
    const a = (await json(await add(w, w.A, 'acme.com'))).claim;
    const b = (await json(await add(w, w.B, 'acme.com'))).claim;
    // B publishes ITS token, A publishes its own; A verifies first.
    w.cf.doh['_inboxangel.acme.com'] = [a.txt_value, b.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${a.id}/verify`, { key: w.A.token, body: {} })).status).toBe(201);

    const list = await json(await call(w.env, 'GET', '/api/domains', { key: w.B.token }));
    expect(list.domains).toEqual([]);
    expect(list.pending_claims).toMatchObject([{ domain: 'acme.com', status: 'lost' }]);
    const late = await call(w.env, 'POST', `/api/domains/claims/${b.id}/verify`, { key: w.B.token, body: {} });
    expect(late.status).toBe(409);
    expect((await json(late)).code).toBe('domain_taken');
    expect((await add(w, w.B, 'acme.com')).status).toBe(409);
    // A's data is untouched and B sees nothing of it
    expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'acme.com'")).toEqual([{ workspace_id: w.A.ws }]);
  });

  it('a workspace cannot verify, read or drop another workspace’s claim', async () => {
    const w = await world();
    const a = (await json(await add(w, w.A, 'acme.com'))).claim;
    w.cf.doh['_inboxangel.acme.com'] = [a.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${a.id}/verify`, { key: w.B.token, body: {} })).status).toBe(404);
    expect((await call(w.env, 'DELETE', `/api/domains/claims/${a.id}`, { key: w.B.token })).status).toBe(404);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
    expect(w.rows('SELECT * FROM domain_claims')).toHaveLength(1);
    expect((await call(w.env, 'DELETE', `/api/domains/claims/${a.id}`, { key: w.A.token })).status).toBe(200);
  });

  it('a verified domain’s owner is never displaced by a later claim', async () => {
    const w = await world();
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(w.A.ws);
    expect((await add(w, w.B, 'acme.com')).status).toBe(409);
    expect(w.rows('SELECT * FROM domain_claims')).toEqual([]);
  });

  it('caps the unverified claims one workspace can hold', async () => {
    const w = await world();
    for (let i = 0; i < 25; i++) expect((await add(w, w.A, `d${i}.example.net`)).status).toBe(202);
    expect((await add(w, w.A, 'one-too-many.example.net')).status).toBe(429);
    expect((await add(w, w.B, 'd0.example.net')).status).toBe(202); // the cap is per workspace
  });
});

describe('other proofs', () => {
  /** What Cloudflare says right now about each zone id (the stored allow-list is re-checked against it). */
  let live: Record<string, { name: string; status: string } | Error> = {};
  const liveZones = (zones: Record<string, { name: string; status: string } | Error>) => {
    live = zones;
    vi.spyOn(ConnectionService.prototype, 'clientFor').mockImplementation(async () => ({
      getZone: async (id: string) => { const z = live[id]; if (!z || z instanceof Error) throw z ?? new Error('gone'); return { id, ...z }; },
    }) as any);
  };
  const connect = (w: Awaited<ReturnType<typeof world>>, ws: string, zone: string, status = 'active') => {
    liveZones({ ['1'.repeat(32)]: { name: zone, status: 'active' } });
    w.db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope, status) VALUES ('cfc_1', ?, 'x', 'token', 'e', ?)").run(ws, status);
    w.db.sqlite.prepare("INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name) VALUES ('cfc_1', ?, ?, ?)").run(ws, '1'.repeat(32), zone);
  };

  it('a domain whose zone is on an active connection’s allow-list is verified at once (and its subdomains)', async () => {
    const w = await world();
    connect(w, w.A.ws, 'acme.com');
    expect((await add(w, w.A, 'acme.com')).status).toBe(201);
    expect(w.rows("SELECT verified_via FROM domains WHERE domain = 'acme.com'")).toEqual([{ verified_via: 'cloudflare' }]);
    const sub = await add(w, w.A, 'mail.acme.com');
    expect(sub.status).toBe(201);
    // other workspace, same name: no proof, pending
    expect((await add(w, w.B, 'acme.com')).status).toBe(409);
    expect((await add(w, w.B, 'other.acme.com')).status).toBe(202);
  });

  it('re-checks the zone with Cloudflare: a zone that has moved away, expired or is not active proves nothing', async () => {
    for (const gone of [{ name: 'acme.com', status: 'moved' }, { name: 'other.org', status: 'active' }, new Error('404')]) {
      const w = await world();
      connect(w, w.A.ws, 'acme.com');
      liveZones({ ['1'.repeat(32)]: gone as any });
      expect((await add(w, w.A, 'acme.com')).status).toBe(202);
      expect(w.rows('SELECT * FROM domains')).toEqual([]);
    }
  });

  it('a connection that is not active, or whose zone is another name, proves nothing', async () => {
    const w = await world();
    connect(w, w.A.ws, 'acme.com', 'broken');
    expect((await add(w, w.A, 'acme.com')).status).toBe(202);
    const w2 = await world();
    connect(w2, w2.A.ws, 'acme.org');
    expect((await add(w2, w2.A, 'acme.com')).status).toBe(202);
    expect((await add(w2, w2.A, 'acmeXorg.com')).status).toBe(202);
  });

  it('a child zone that is not allowed does not inherit its parent’s proof', async () => {
    const w = await world();
    connect(w, w.A.ws, 'acme.com');
    w.db.sqlite.prepare("INSERT INTO cloudflare_connection_blocked_zones (connection_id, workspace_id, zone_id, zone_name) VALUES ('cfc_1', ?, ?, 'sub.acme.com')").run(w.A.ws, '2'.repeat(32));
    expect((await add(w, w.A, 'x.sub.acme.com')).status).toBe(202);
    expect((await add(w, w.A, 'ok.acme.com')).status).toBe(201);
  });

  it('bulk import and the setup wizard’s base domain go through the same gate', async () => {
    const w = await world();
    const bulk = await json(await call(w.env, 'POST', '/api/domains/bulk-import', { key: w.A.token, body: { domains: 'one.example.net\ntwo.example.net' } }));
    expect(bulk.results.map((r: any) => r.status)).toEqual(['pending', 'pending']);
    expect(bulk.results[0].claim.txt_name).toBe('_inboxangel.one.example.net');
    const base = await call(w.env, 'POST', '/api/settings/base-domain', { key: w.A.token, body: { domain: 'hub.example.net' } });
    expect(base.status).toBe(202);
    expect(w.rows("SELECT * FROM domains")).toEqual([]);
    expect(w.rows("SELECT * FROM settings WHERE key = 'base_domain'")).toEqual([]);
  });
});

describe('self-host', () => {
  it('every domain is the operator’s own: verified on the spot, no claims', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'reports_domain', 'reports.me.test')").run();
    const res = await call(env, 'POST', '/api/domains', { key: owner, body: { domain: 'acme.com' } });
    expect(res.status).toBe(201);
    expect(db.sqlite.prepare("SELECT verified_via FROM domains WHERE domain = 'acme.com'").all()).toEqual([{ verified_via: 'selfhost' }]);
    expect(db.sqlite.prepare('SELECT * FROM domain_claims').all()).toEqual([]);
  });
});

describe('free-check results never reach other people’s workspaces', () => {
  const seed = (db: any) => {
    const ins = db.sqlite.prepare("INSERT INTO check_results (from_email, from_domain, spf_result, dkim_result, dmarc_result, dmarc_policy, overall_status, session_token, created_at) VALUES (?, ?, 'pass', 'fail', 'fail', 'none', 'exposed', ?, ?)");
    ins.run('alice@acme.com', 'acme.com', 'tok-alice', 1000);
    ins.run('bob@acme.com', 'acme.com', 'tok-bob', 2000);
    ins.run('carol@gmail.com', 'gmail.com', 'tok-carol', 3000);
    ins.run('dave@other.net', 'other.net', 'tok-dave', 4000);
  };

  it('returns the newest domain-level result per verified domain: no sender address, no session token', async () => {
    const w = await world();
    seed(w.db);
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id) VALUES ('acme.com', 'x', ?)").run(w.A.ws);
    const res = await call(w.env, 'GET', '/api/check-results', { key: w.A.token });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ from_domain: 'acme.com', overall_status: 'exposed', created_at: 2000 });
    for (const secret of ['alice', 'bob', 'carol', 'dave', 'tok-', 'from_email', 'session_token']) expect(text).not.toContain(secret);
  });

  it('claiming gmail.com (pending) reveals nothing, and neither does a pending claim on a name another workspace verified', async () => {
    const w = await world();
    seed(w.db);
    expect((await add(w, w.B, 'gmail.com')).status).toBe(202);
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id) VALUES ('acme.com', 'x', ?)").run(w.A.ws);
    expect((await json(await call(w.env, 'GET', '/api/check-results', { key: w.B.token }))).results).toEqual([]);
    const text = await (await call(w.env, 'GET', '/api/check-results', { key: w.A.token })).text();
    expect(text).not.toContain('carol');
  });
});

describe('legacy rows (domains that existed before verification) never block a proven claim', () => {
  const legacy = (w: Awaited<ReturnType<typeof world>>, domain: string) =>
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES (?, 'x', ?, 'legacy')").run(domain, w.A.ws);

  it('a legacy holder does not make the name “taken”; a TXT proof evicts it, with an audit entry in the evicted workspace', async () => {
    const w = await world();
    legacy(w, 'acme.com');
    const res = await add(w, w.B, 'acme.com');
    expect(res.status).toBe(202); // not 409
    const { claim } = await json(res);
    expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'acme.com'")).toEqual([{ workspace_id: w.A.ws }]); // not evicted without proof
    w.cf.doh['_inboxangel.acme.com'] = [claim.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: w.B.token, body: {} })).status).toBe(201);
    expect(w.rows("SELECT workspace_id, verified_via FROM domains WHERE domain = 'acme.com'")).toEqual([{ workspace_id: w.B.ws, verified_via: 'txt' }]);
    await new Promise(r => setTimeout(r, 20));
    expect(w.rows("SELECT action, resource_name FROM audit_log WHERE workspace_id = ? AND action = 'domain.evicted'", w.A.ws)).toEqual([{ action: 'domain.evicted', resource_name: 'acme.com' }]);
  });

  it('a verified (non-legacy) holder still wins', async () => {
    const w = await world();
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(w.A.ws);
    expect((await add(w, w.B, 'acme.com')).status).toBe(409);
  });

  it('a legacy parent proves nothing about its subdomains', async () => {
    const w = await world();
    legacy(w, 'acme.com');
    expect((await add(w, w.A, 'mail.acme.com')).status).toBe(202);
  });
});

describe('concurrent verification', () => {
  it('two workspaces verifying the same name at once: exactly one wins, the other gets a 409 and owns nothing', async () => {
    const w = await world();
    const a = (await json(await add(w, w.A, 'acme.com'))).claim;
    const b = (await json(await add(w, w.B, 'acme.com'))).claim;
    w.cf.doh['_inboxangel.acme.com'] = [a.txt_value, b.txt_value];
    const [ra, rb] = await Promise.all([
      call(w.env, 'POST', `/api/domains/claims/${a.id}/verify`, { key: w.A.token, body: {} }),
      call(w.env, 'POST', `/api/domains/claims/${b.id}/verify`, { key: w.B.token, body: {} }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'acme.com'")).toHaveLength(1);
  });
});
