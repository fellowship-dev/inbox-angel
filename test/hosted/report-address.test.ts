// G1: a report address for a verified domain without hosted records, through the real router and the real inbound path.
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { intakeLookups, resetSchemaReadyCache, TOKEN_ROTATION_GRACE_SECONDS } from '@inbox-angel/db';
import worker from '../../src/index';
import { handleHostedEmail } from '../../src/hosted/intake';
import { generateToken } from '../../src/hosted/tokens';
import { call, inviteAndAccept, makeEnv, signupVerified } from '../auth/helpers';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { quiet } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const RUA = 'rua.inboxangel.io';
const ADDRESS = /^rua\+([a-z2-7]{32})@rua\.inboxangel\.io$/;
/** Report intake only: no records zone, no records token, no free-check domain. */
const INTAKE_ONLY = { MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Live DNS for the router's resolver: TXT answers by name; anything else (and IP enrichment) is NXDOMAIN. */
let txt: Record<string, string[] | 'SERVFAIL'> = {};
beforeEach(() => {
  quiet();
  resetSchemaReadyCache();
  txt = {};
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const name = (u.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
    const v = u.searchParams.get('type') === 'TXT' ? txt[name] : undefined;
    if (v === 'SERVFAIL') return Response.json({ Status: 2 });
    if (!v) return Response.json({ Status: 3 });
    return Response.json({ Status: 0, Answer: v.map(d => ({ name, type: 16, TTL: 60, data: `"${d}"` })) });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function world(extra: Record<string, string> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...INTAKE_ONLY, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const signup = async (email: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    return { token, ws };
  };
  const A = await signup('a-owner@example.com');
  const B = await signup('b-owner@example.com');
  const ins = db.sqlite.prepare('INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via, evicted_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, A.ws, 'a-corp.com', '', 'txt', null);
  ins.run(2, B.ws, 'b-corp.org', '', 'txt', null);
  ins.run(3, A.ws, 'legacy-a.com', '', 'legacy', null); // added before ownership checks
  ins.run(4, A.ws, 'evicted-4.invalid', '', 'legacy', 1_700_000_000); // lost to another workspace's proof
  ins.run(5, A.ws, 'mail.a-corp.com', '', 'parent', null);
  db.sqlite.prepare("INSERT INTO domain_claims (id, workspace_id, domain, token) VALUES (6, ?, 'pending-a.com', 'claim-token')").run(A.ws);
  const issue = async (id: number, key = A.token) => {
    const res = await call(env, 'POST', `/api/domains/${id}/report-address`, { key, body: {} });
    return { res, body: await res.json() as any };
  };
  const status = async (id: number, key = A.token) => (await call(env, 'GET', `/api/domains/${id}/report-address`, { key })).json() as Promise<any>;
  const deliver = async (to: string, policyDomain: string, reportId: string) => {
    const m = fakeMessage(to, gzipReportMime(dmarcXml(policyDomain, reportId)));
    await handleHostedEmail(m, env as any);
    return m;
  };
  return { db, env, rows, A, B, issue, status, deliver };
}

describe('issuing a report address (G1)', () => {
  it('before: no address, nothing looked up in DNS; after: an unguessable per-domain address, stored as a hash, shown again on every read', async () => {
    const w = await world();
    const before = await w.status(1);
    expect(before).toMatchObject({ available: true, domain: 'a-corp.com', managed_by: null, can_issue: true, address: null, state: 'not_issued', dns: null });

    txt['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com'];
    const { res, body } = await w.issue(1);
    expect(res.status).toBe(201);
    const token = ADDRESS.exec(body.address)?.[1];
    expect(token).toBeDefined();
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: body.address }]);
    const stored = w.rows('SELECT workspace_id, token_hash, prev_token_hash FROM intake_tokens WHERE domain_id = 1');
    expect(stored).toEqual([{ workspace_id: w.A.ws, token_hash: sha256(token!), prev_token_hash: null }]);
    // The live record keeps p=reject and its own address; ours is added second.
    expect(body).toMatchObject({ state: 'not_published', dns: { error: null, plan: { kind: 'add', name: '_dmarc.a-corp.com', record: `v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com,mailto:${body.address}` } } });
    expect((await w.status(1)).address).toBe(body.address);

    // Issuing again changes nothing: same address, no new token (a double click is harmless).
    const again = await w.issue(1);
    expect(again.res.status).toBe(200);
    expect(again.body.address).toBe(body.address);
    expect(w.rows('SELECT token_hash, prev_token_hash FROM intake_tokens WHERE domain_id = 1')).toEqual([{ token_hash: sha256(token!), prev_token_hash: null }]);
    expect(w.rows("SELECT action FROM audit_log WHERE action LIKE 'report_address.%'")).toEqual([{ action: 'report_address.issue' }]);
  });

  it('tokens are unique per domain and per issue', async () => {
    const w = await world();
    const a = (await w.issue(1)).body.address;
    const sub = (await w.issue(5)).body.address;
    const b = (await w.issue(2, w.B.token)).body.address;
    expect(new Set([a, sub, b]).size).toBe(3);
  });

  it('states over time: not published → published, waiting → receiving after a report arrives through the inbound path', async () => {
    const w = await world();
    const { body } = await w.issue(1);
    expect(body.state).toBe('not_published'); // no DMARC record at all
    expect(body.dns.plan).toEqual({ kind: 'add', name: '_dmarc.a-corp.com', current: null, record: `v=DMARC1; p=none; rua=mailto:${body.address}`, created: true });

    txt['_dmarc.a-corp.com'] = [`v=DMARC1; p=quarantine; rua=mailto:${body.address.toUpperCase()}`];
    expect(await w.status(1)).toMatchObject({ state: 'waiting', last_report_at: null, dns: { plan: { kind: 'published' } } });

    const m = fakeMessage(body.address, gzipReportMime(dmarcXml('a-corp.com', 'first-report')));
    await worker.email(m, w.env as any, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    const after = await w.status(1);
    expect(after.state).toBe('receiving');
    expect(after.last_report_at).toEqual(expect.any(Number));
    expect(w.rows('SELECT workspace_id, domain_id, report_id FROM aggregate_reports')).toEqual([{ workspace_id: w.A.ws, domain_id: 1, report_id: 'first-report' }]);
  });

  it('a failed DNS lookup is "unknown", never "not published"', async () => {
    const w = await world();
    await w.issue(1);
    txt['_dmarc.a-corp.com'] = 'SERVFAIL';
    expect(await w.status(1)).toMatchObject({ state: 'unknown', dns: { plan: null, error: expect.any(String) } });
  });

  it('a subdomain that inherits its policy is told where the record lives and what its own record would be', async () => {
    const w = await world();
    txt['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com'];
    const { body } = await w.issue(5);
    expect(body.dns.plan).toMatchObject({ kind: 'inherited', from: 'a-corp.com', policy: 'reject', own: { kind: 'add', name: '_dmarc.mail.a-corp.com', record: `v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com,mailto:${body.address}` } });
  });
});

describe('rotation and revocation', () => {
  it('rotate: the new address works at once; the old one only for the grace period, then never', async () => {
    const w = await world();
    const first = (await w.issue(1)).body.address as string;
    const rot = await call(w.env, 'POST', '/api/domains/1/report-address/rotate', { key: w.A.token, body: {} });
    expect(rot.status).toBe(200);
    const next = await rot.json() as any;
    expect(next.address).not.toBe(first);
    expect(next.address).toMatch(ADDRESS);
    expect(next.previous_valid_until).toBeGreaterThan(Date.now() / 1000 + TOKEN_ROTATION_GRACE_SECONDS - 60);
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: next.address }]);

    const look = intakeLookups(w.env.DB as any);
    const now = Math.floor(Date.now() / 1000);
    const hashOf = (a: string) => sha256(ADDRESS.exec(a)![1]);
    expect((await look.resolveToken(hashOf(next.address), now))?.domain_id).toBe(1);
    expect((await look.resolveToken(hashOf(first), now))?.domain_id).toBe(1); // in flight: receivers cache the address
    expect(await look.resolveToken(hashOf(first), now + TOKEN_ROTATION_GRACE_SECONDS + 5)).toBeNull();

    // A second rotation ends the first address's grace at once.
    const third = await (await call(w.env, 'POST', '/api/domains/1/report-address/rotate', { key: w.A.token, body: {} })).json() as any;
    expect(await look.resolveToken(hashOf(first), now)).toBeNull();
    expect((await look.resolveToken(hashOf(next.address), now))?.domain_id).toBe(1);
    expect((await look.resolveToken(hashOf(third.address), now))?.domain_id).toBe(1);
  });

  it('rotate without an address is refused', async () => {
    const w = await world();
    const res = await call(w.env, 'POST', '/api/domains/1/report-address/rotate', { key: w.A.token, body: {} });
    expect(res.status).toBe(409);
    expect(w.rows('SELECT * FROM intake_tokens')).toEqual([]);
  });

  it('revoke: the address (and a rotated one in its grace) stop working now; stored reports stay', async () => {
    const w = await world();
    const first = (await w.issue(1)).body.address as string;
    expect((await w.deliver(first, 'a-corp.com', 'kept')).setReject).not.toHaveBeenCalled();
    const second = (await (await call(w.env, 'POST', '/api/domains/1/report-address/rotate', { key: w.A.token, body: {} })).json() as any).address as string;
    const del = await call(w.env, 'DELETE', '/api/domains/1/report-address', { key: w.A.token });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ state: 'not_issued', address: null });
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: '' }]);
    expect(w.rows('SELECT * FROM intake_tokens')).toEqual([]);
    for (const [to, id] of [[first, 'after-1'], [second, 'after-2']]) {
      const m = await w.deliver(to, 'a-corp.com', id);
      expect(m.setReject).toHaveBeenCalledWith('Unknown intake token');
    }
    expect(w.rows('SELECT report_id FROM aggregate_reports')).toEqual([{ report_id: 'kept' }]);
  });
});

describe('who may issue, and for what', () => {
  it('a read-only member sees the state but cannot issue, rotate or revoke; an admin can', async () => {
    const w = await world();
    const member = await inviteAndAccept(w.env, w.A.token, 'member@example.com', 'member');
    const admin = await inviteAndAccept(w.env, w.A.token, 'admin@example.com', 'admin');
    expect((await w.status(1, member)).state).toBe('not_issued');
    expect((await w.issue(1, member)).res.status).toBe(403);
    expect(w.rows('SELECT * FROM intake_tokens')).toEqual([]);

    const issued = await w.issue(1, admin);
    expect(issued.res.status).toBe(201);
    expect((await w.status(1, member)).address).toBe(issued.body.address); // the address is public: members may read it
    for (const [method, path] of [['POST', '/api/domains/1/report-address/rotate'], ['DELETE', '/api/domains/1/report-address']] as const) {
      expect((await call(w.env, method, path, { key: member, body: method === 'POST' ? {} : undefined })).status).toBe(403);
    }
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: issued.body.address }]);
  });

  it('never for an unverified claim, a lost (evicted) domain or a row added before ownership checks', async () => {
    const w = await world();
    expect((await w.issue(6)).res.status).toBe(404); // a pending claim's id is not a domain
    expect((await w.issue(4)).res.status).toBe(404); // evicted
    const legacy = await w.issue(3);
    expect(legacy.res.status).toBe(403);
    expect(legacy.body.error).toMatch(/added before ownership checks/);
    expect(await w.status(3)).toMatchObject({ can_issue: false, refusal: expect.stringMatching(/prove that you control it/) });
    expect(w.rows('SELECT * FROM intake_tokens')).toEqual([]);
    expect(w.rows('SELECT id, rua_address FROM domains WHERE id IN (3, 4)')).toEqual([{ id: 3, rua_address: '' }, { id: 4, rua_address: '' }]);
  });

  it('an address issued before eviction stops filing once the domain is lost', async () => {
    const w = await world();
    const address = (await w.issue(1)).body.address as string;
    w.db.sqlite.prepare("UPDATE domains SET evicted_at = 1700000000, evicted_name = domain, domain = 'evicted-1.invalid' WHERE id = 1").run();
    expect((await w.deliver(address, 'a-corp.com', 'late')).setReject).toHaveBeenCalledWith('Unknown intake token');
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('a domain with hosted records keeps its own address there: this API reports that and refuses to change it', async () => {
    const w = await world();
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key) VALUES (1, ?, 'abcdefghijklmnop', 'z1')").run(w.A.ws);
    expect(await w.status(1)).toMatchObject({ managed_by: 'hosted_records', can_issue: false, address: null });
    expect((await w.issue(1)).res.status).toBe(409);
    expect((await call(w.env, 'DELETE', '/api/domains/1/report-address', { key: w.A.token })).status).toBe(409);
  });
});

describe('isolation between workspaces', () => {
  it('A cannot read, issue, rotate or revoke B’s address; nothing of B changes', async () => {
    const w = await world();
    const bAddress = (await w.issue(2, w.B.token)).body.address as string;
    const before = JSON.stringify([w.rows('SELECT * FROM intake_tokens WHERE domain_id = 2'), w.rows('SELECT rua_address FROM domains WHERE id = 2')]);
    for (const [method, path] of [['GET', ''], ['POST', ''], ['POST', '/rotate'], ['DELETE', '']] as const) {
      const res = await call(w.env, method, `/api/domains/2/report-address${path}`, { key: w.A.token, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).not.toContain(ADDRESS.exec(bAddress)![1]);
    }
    expect(JSON.stringify([w.rows('SELECT * FROM intake_tokens WHERE domain_id = 2'), w.rows('SELECT rua_address FROM domains WHERE id = 2')])).toBe(before);
  });

  it('A’s issued address can never file a report for B’s domain, and B’s never for A’s', async () => {
    const w = await world();
    const a = (await w.issue(1)).body.address as string;
    const b = (await w.issue(2, w.B.token)).body.address as string;
    expect((await w.deliver(a, 'b-corp.org', 'spoof-b')).setReject).toHaveBeenCalledWith(expect.stringMatching(/Unknown domain b-corp\.org/));
    expect((await w.deliver(b, 'a-corp.com', 'spoof-a')).setReject).toHaveBeenCalledWith(expect.stringMatching(/Unknown domain a-corp\.com/));
    // nor for another domain of the same workspace, nor the parent of a subdomain's address
    const sub = (await w.issue(5)).body.address as string;
    expect((await w.deliver(sub, 'a-corp.com', 'parent')).setReject).toHaveBeenCalledOnce();
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('guessing: a well-formed random token, a truncated or altered real one, and the right token at another host are all refused', async () => {
    const w = await world();
    const a = (await w.issue(1)).body.address as string;
    const token = ADDRESS.exec(a)![1];
    const flip = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    for (const to of [`rua+${generateToken()}@${RUA}`, `rua+${token.slice(0, 31)}@${RUA}`, `rua+${flip}@${RUA}`, `rua+${token}@rua.evil.test`, `tls+${token}@${RUA}`]) {
      const m = await w.deliver(to, 'a-corp.com', `guess-${to}`);
      expect(m.setReject, to).toHaveBeenCalledOnce();
    }
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
    expect(w.rows('SELECT * FROM intake_usage')).toEqual([]); // refused before any allowance was touched
  });
});

describe('deployment settings', () => {
  it('without INTAKE_DOMAIN: available false, and issuing is refused', async () => {
    const w = await world({ INTAKE_DOMAIN: '' });
    expect(await w.status(1)).toEqual({ available: false });
    expect((await w.issue(1)).res.status).toBe(404);
    expect(w.rows('SELECT * FROM intake_tokens')).toEqual([]);
  });

  it('GET /api/hosted/config says which hosted parts are on', async () => {
    const w = await world();
    expect(await (await call(w.env, 'GET', '/api/hosted/config', { key: w.A.token })).json()).toEqual({ enabled: true, reports: true, records: false });
  });

  it('self-host: the route does not exist', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const setup = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'password-123' } });
    const owner = (await setup.json() as any).token as string;
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, 'ws_default', 'self.example', 'rua@reports.self.example', 'selfhost')").run();
    expect((await call(env, 'GET', '/api/domains/1/report-address', { key: owner })).status).toBe(404);
    expect((await call(env, 'POST', '/api/domains/1/report-address', { key: owner, body: {} })).status).toBe(404);
    expect(db.sqlite.prepare('SELECT rua_address FROM domains WHERE id = 1').all()).toEqual([{ rua_address: 'rua@reports.self.example' }]);
  });
});

describe('report intake without the free check (G3)', () => {
  it('INTAKE_DOMAIN alone: reports are filed; check mail is refused; no free-check address is handed out', async () => {
    const w = await world(); // no CANARY_DOMAIN
    const address = (await w.issue(1)).body.address as string;
    expect((await w.deliver(address, 'a-corp.com', 'no-canary')).setReject).not.toHaveBeenCalled();
    const check = fakeMessage('check+abcdefghijklmnopqrstuvwxyz234567@canary.inboxangel.io', 'Subject: hi\r\n\r\nhello');
    await handleHostedEmail(check, w.env as any);
    expect(check.setReject).toHaveBeenCalledWith('Unknown recipient');
    const session = await call(w.env, 'POST', '/api/check-sessions', { body: {} });
    expect(session.status).toBe(404);
    expect(await session.json()).toEqual({ error: 'The free email check is not available on this server' });
  });

  it('CANARY_DOMAIN alone: the free check still takes its mail; report mail is deferred (the sender retries) until INTAKE_DOMAIN is set', async () => {
    const w = await world({ INTAKE_DOMAIN: '', CANARY_DOMAIN: 'canary.inboxangel.io' });
    const session = await call(w.env, 'POST', '/api/check-sessions', { body: {} });
    expect(session.status).toBe(201);
    const { email } = await session.json() as { email: string };
    const check = fakeMessage(email, 'Subject: hi\r\n\r\nhello');
    await expect(handleHostedEmail(check, w.env as any)).resolves.toBeUndefined();
    const report = fakeMessage(`rua+${generateToken()}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    await expect(handleHostedEmail(report, w.env as any)).rejects.toThrow(/INTAKE_DOMAIN/);
    expect(report.setReject).not.toHaveBeenCalled();
  });
});
