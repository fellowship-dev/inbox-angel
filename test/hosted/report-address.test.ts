// G1/G3: connecting a verified domain's reports to the fixed hosted address (rua@<INTAKE_DOMAIN>), through the real
// router and the real inbound path. No token, no records zone, no free-check domain.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { forWorkspace, resetSchemaReadyCache } from '@inbox-angel/db';
import worker from '../../src/index';
import { handleHostedEmail } from '../../src/hosted/intake';
import { reportDomainCandidates } from '../../src/hosted/fixed-address';
import { generateToken, hashToken } from '../../src/hosted/tokens';
import { call, inviteAndAccept, makeEnv, signupVerified } from '../auth/helpers';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment, tlsRptJson, tlsRptMime, zipReportMime } from '../helpers/mail';
import { gzipSync, strToU8 } from 'fflate';
import { quiet } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const RUA = 'rua.inboxangel.io';
const FIXED = `rua@${RUA}`;
/** Report intake only: no records zone, no records token, no free-check domain. */
const INTAKE_ONLY = { MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

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
  const connect = async (id: number, key = A.token) => {
    const res = await call(env, 'POST', `/api/domains/${id}/report-address`, { key, body: {} });
    return { res, body: await res.json() as any };
  };
  const disconnect = (id: number, key = A.token) => call(env, 'DELETE', `/api/domains/${id}/report-address`, { key });
  const status = async (id: number, key = A.token) => (await call(env, 'GET', `/api/domains/${id}/report-address`, { key })).json() as Promise<any>;
  const deliver = async (to: string, policyDomain: string, reportId: string) => {
    const m = fakeMessage(to, gzipReportMime(dmarcXml(policyDomain, reportId)));
    await handleHostedEmail(m, env as any);
    return m;
  };
  const stored = () => rows('SELECT workspace_id, domain_id, report_id FROM aggregate_reports ORDER BY id');
  return { db, env, rows, A, B, connect, disconnect, status, deliver, stored };
}

describe('connecting reports (G1, fixed address)', () => {
  it('before: not connected, no DNS lookup; after: the fixed address, nothing issued, shown with the record to publish', async () => {
    const w = await world();
    expect(await w.status(1)).toMatchObject({ available: true, domain: 'a-corp.com', managed_by: null, can_connect: true, address: null, state: 'not_connected', dns: null });

    txt['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com'];
    const { res, body } = await w.connect(1);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ address: FIXED, state: 'not_published', dns: { error: null, plan: { kind: 'add', name: '_dmarc.a-corp.com', record: `v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com,mailto:${FIXED}` } } });
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: FIXED }]);
    expect(w.rows('SELECT * FROM intake_tokens')).toEqual([]); // no token
    const again = await w.connect(1);
    expect(again.res.status).toBe(200);
    expect(w.rows("SELECT action FROM audit_log WHERE action LIKE 'reports.%'")).toEqual([{ action: 'reports.connect' }]);
  });

  it('states from evidence: not published → published, waiting → receiving after a report arrives through the Worker', async () => {
    const w = await world();
    const { body } = await w.connect(1);
    expect(body.dns.plan).toEqual({ kind: 'add', name: '_dmarc.a-corp.com', current: null, record: `v=DMARC1; p=none; rua=mailto:${FIXED}`, created: true });

    txt['_dmarc.a-corp.com'] = [`v=DMARC1; p=quarantine; rua=mailto:${FIXED.toUpperCase()}`];
    expect(await w.status(1)).toMatchObject({ state: 'waiting', last_report_at: null, dns: { plan: { kind: 'published' } } });

    const m = fakeMessage(FIXED, gzipReportMime(dmarcXml('a-corp.com', 'first-report')));
    await worker.email(m, w.env as any, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ state: 'receiving', last_report_at: expect.any(Number) });
    expect(w.stored()).toEqual([{ workspace_id: w.A.ws, domain_id: 1, report_id: 'first-report' }]);
  });

  it('a failed DNS lookup is "unknown", never "not published"', async () => {
    const w = await world();
    await w.connect(1);
    txt['_dmarc.a-corp.com'] = 'SERVFAIL';
    expect(await w.status(1)).toMatchObject({ state: 'unknown', dns: { plan: null, error: expect.any(String) } });
  });

  it('a subdomain that inherits its policy is told where the record lives and what its own record would be', async () => {
    const w = await world();
    txt['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com'];
    const { body } = await w.connect(5);
    expect(body.dns.plan).toMatchObject({ kind: 'inherited', from: 'a-corp.com', policy: 'reject', own: { kind: 'add', name: '_dmarc.mail.a-corp.com', record: `v=DMARC1; p=reject; rua=mailto:dmarc@a-corp.com,mailto:${FIXED}` } });
  });

  it('disconnect: reports for the domain are refused from then on; stored reports stay', async () => {
    const w = await world();
    await w.connect(1);
    expect((await w.deliver(FIXED, 'a-corp.com', 'kept')).setReject).not.toHaveBeenCalled();
    const del = await w.disconnect(1);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ state: 'not_connected', address: null });
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: '' }]);
    const late = await w.deliver(FIXED, 'a-corp.com', 'late');
    expect(late.setReject).toHaveBeenCalledWith(expect.stringMatching(/Unknown domain a-corp\.com/));
    expect(w.stored().map(r => r.report_id)).toEqual(['kept']);
    expect(w.rows('SELECT * FROM intake_usage')).toEqual([{ domain_id: 1, workspace_id: w.A.ws, day: expect.any(String), reporter: expect.any(String), reports: 1, bytes: expect.any(Number) }]); // the refused one used no allowance
  });
});

describe('the fixed address files by verified ownership', () => {
  it('each report goes to the one workspace that proved its domain and connected it; the same address serves every workspace', async () => {
    const w = await world();
    await w.connect(1);
    await w.connect(2, w.B.token);
    expect((await w.deliver(FIXED, 'a-corp.com', 'ra')).setReject).not.toHaveBeenCalled();
    expect((await w.deliver(FIXED, 'B-Corp.org', 'rb')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.A.ws, domain_id: 1, report_id: 'ra' }, { workspace_id: w.B.ws, domain_id: 2, report_id: 'rb' }]);
  });

  it('refused, stored nowhere, no allowance used: an unknown domain, a domain proven but not connected, a pending claim, a legacy row, an evicted row', async () => {
    const w = await world();
    await w.connect(1);
    w.db.sqlite.prepare(`UPDATE domains SET rua_address = ? WHERE id IN (3, 4)`).run(FIXED); // even if they somehow carried the address
    for (const d of ['nobody.example', 'b-corp.org', 'pending-a.com', 'legacy-a.com', 'evicted-4.invalid']) {
      const m = await w.deliver(FIXED, d, `x-${d}`);
      expect(m.setReject, d).toHaveBeenCalledWith(expect.stringMatching(/^Unknown domain/));
    }
    expect(w.stored()).toEqual([]);
    expect(w.rows('SELECT * FROM intake_usage')).toEqual([]);
  });

  it('a subdomain report: filed under the subdomain’s own row in the same workspace, or under the connected parent', async () => {
    const w = await world();
    await w.connect(1); // a-corp.com connected; mail.a-corp.com (same workspace) is not
    expect((await w.deliver(FIXED, 'mail.a-corp.com', 'sub-own-row')).setReject).not.toHaveBeenCalled();
    expect((await w.deliver(FIXED, 'x.y.a-corp.com', 'deep')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.A.ws, domain_id: 5, report_id: 'sub-own-row' }, { workspace_id: w.A.ws, domain_id: 1, report_id: 'deep' }]);
  });

  it('the most specific owner decides: another workspace’s connected parent never receives a subdomain it does not own', async () => {
    const w = await world();
    await w.connect(1);
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (7, ?, 'shop.a-corp.com', '', 'txt')").run(w.B.ws);
    const m = await w.deliver(FIXED, 'shop.a-corp.com', 'b-sub');
    expect(m.setReject).toHaveBeenCalledWith(expect.stringMatching(/Unknown domain shop\.a-corp\.com/)); // B owns it and has not connected
    await w.connect(7, w.B.token);
    expect((await w.deliver(FIXED, 'shop.a-corp.com', 'b-sub-2')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.B.ws, domain_id: 7, report_id: 'b-sub-2' }]);
  });

  it('a domain moved to another workspace: reports follow the new verified owner with no DNS change', async () => {
    const w = await world();
    await w.connect(1);
    w.db.sqlite.prepare('DELETE FROM domains WHERE id = 1').run();
    expect((await w.deliver(FIXED, 'a-corp.com', 'gap')).setReject).toHaveBeenCalledOnce();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (8, ?, 'a-corp.com', ?, 'txt')").run(w.B.ws, FIXED);
    expect((await w.deliver(FIXED, 'a-corp.com', 'moved')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.B.ws, domain_id: 8, report_id: 'moved' }]);
  });

  it('public suffixes and look-alikes never match', () => {
    expect(reportDomainCandidates('Mail.EU.a-corp.com.')).toEqual(['mail.eu.a-corp.com', 'eu.a-corp.com', 'a-corp.com']);
    expect(reportDomainCandidates('x.example.co.uk')).toEqual(['x.example.co.uk', 'example.co.uk']);
    expect(reportDomainCandidates('co.uk')).toEqual([]);
    expect(reportDomainCandidates('com')).toEqual([]);
  });

  it('unreadable or non-report mail to the fixed address is refused before any allowance or database write', async () => {
    const w = await world();
    await w.connect(1);
    for (const raw of [
      'Subject: hello\r\n\r\njust text',
      mimeWithAttachment(strToU8('not a report'), 'r.xml.gz', 'application/gzip'),
      mimeWithAttachment(strToU8('<?xml version="1.0"?><feedback><report_metadata/></feedback>'), 'r.xml', 'text/xml'),
      mimeWithAttachment(gzipSync(strToU8('<?xml version="1.0"?><feedback>' + ' '.repeat(26 * 1024 * 1024) + '</feedback>')), 'r.xml.gz', 'application/gzip'),
    ]) {
      const m = fakeMessage(FIXED, raw);
      await handleHostedEmail(m, w.env as any);
      expect(m.setReject).toHaveBeenCalledOnce();
    }
    expect(w.stored()).toEqual([]);
    expect(w.rows('SELECT * FROM intake_usage')).toEqual([]);
  }, 30_000);

  it('a zip report and the same daily allowance as the token path', async () => {
    const w = await world({ INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '2' });
    await w.connect(1);
    for (const id of ['z1', 'z2', 'z3']) {
      const m = fakeMessage(FIXED, zipReportMime(dmarcXml('a-corp.com', id)), { from: 'reports@reporter.test' });
      await handleHostedEmail(m, w.env as any);
      if (id === 'z3') expect(m.setReject).toHaveBeenCalledWith(expect.stringMatching(/Daily intake limit/));
      else expect(m.setReject).not.toHaveBeenCalled();
    }
    expect(w.stored().map(r => r.report_id)).toEqual(['z1', 'z2']);
  });

  it('tls-rpt@ without a token is still refused (TLS-RPT keeps token addresses)', async () => {
    const w = await world();
    await w.connect(1);
    const m = fakeMessage(`tls-rpt@${RUA}`, tlsRptMime(tlsRptJson('a-corp.com')));
    await handleHostedEmail(m, w.env as any);
    expect(m.setReject).toHaveBeenCalledWith('Unknown intake token');
  });
});

describe('token addresses keep working', () => {
  it('a token address (hosted records, or given out earlier) still files, and shows as connected', async () => {
    const w = await world();
    const token = generateToken();
    await forWorkspace(w.env.DB as any, w.A.ws).intake.set(1, await hashToken(token), Math.floor(Date.now() / 1000));
    w.db.sqlite.prepare('UPDATE domains SET rua_address = ? WHERE id = 1').run(`rua+${token}@${RUA}`);
    expect((await w.deliver(`rua+${token}@${RUA}`, 'a-corp.com', 'tok')).setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ address: `rua+${token}@${RUA}`, state: 'receiving' });
    // Disconnecting stops the token too.
    expect((await w.disconnect(1)).status).toBe(200);
    expect((await w.deliver(`rua+${token}@${RUA}`, 'a-corp.com', 'tok-2')).setReject).toHaveBeenCalledWith('Unknown intake token');
  });

  it('a domain with hosted records keeps its address there: this API reports that and changes nothing', async () => {
    const w = await world();
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key) VALUES (1, ?, 'abcdefghijklmnop', 'z1')").run(w.A.ws);
    expect(await w.status(1)).toMatchObject({ managed_by: 'hosted_records', can_connect: false, address: null });
    expect((await w.connect(1)).res.status).toBe(409);
    expect((await w.disconnect(1)).status).toBe(409);
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: '' }]);
  });
});

describe('who may connect, and for what', () => {
  it('a read-only member sees the state but cannot connect or disconnect; an admin can', async () => {
    const w = await world();
    const member = await inviteAndAccept(w.env, w.A.token, 'member@example.com', 'member');
    const admin = await inviteAndAccept(w.env, w.A.token, 'admin@example.com', 'admin');
    expect((await w.status(1, member)).state).toBe('not_connected');
    expect((await w.connect(1, member)).res.status).toBe(403);
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: '' }]);
    expect((await w.connect(1, admin)).res.status).toBe(201);
    expect((await w.status(1, member)).address).toBe(FIXED);
    expect((await w.disconnect(1, member)).status).toBe(403);
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 1')).toEqual([{ rua_address: FIXED }]);
  });

  it('never for an unverified claim, a lost (evicted) domain or a row added before ownership checks', async () => {
    const w = await world();
    expect((await w.connect(6)).res.status).toBe(404); // a pending claim's id is not a domain
    expect((await w.connect(4)).res.status).toBe(404); // evicted
    const legacy = await w.connect(3);
    expect(legacy.res.status).toBe(403);
    expect(legacy.body.error).toMatch(/added before ownership checks/);
    expect(await w.status(3)).toMatchObject({ can_connect: false, refusal: expect.stringMatching(/prove that you control it/) });
    expect(w.rows('SELECT id, rua_address FROM domains WHERE id IN (3, 4)')).toEqual([{ id: 3, rua_address: '' }, { id: 4, rua_address: '' }]);
  });

  it('A cannot read, connect or disconnect B’s domain; nothing of B changes', async () => {
    const w = await world();
    await w.connect(2, w.B.token);
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const res = await call(w.env, method, '/api/domains/2/report-address', { key: w.A.token, body: method === 'POST' ? {} : undefined });
      expect(res.status, method).toBe(404);
    }
    expect(w.rows('SELECT rua_address FROM domains WHERE id = 2')).toEqual([{ rua_address: FIXED }]);
  });
});

describe('deployment settings', () => {
  it('without INTAKE_DOMAIN: available false, and connecting is refused', async () => {
    const w = await world({ INTAKE_DOMAIN: '' });
    expect(await w.status(1)).toEqual({ available: false });
    expect((await w.connect(1)).res.status).toBe(404);
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
    await w.connect(1);
    expect((await w.deliver(FIXED, 'a-corp.com', 'no-canary')).setReject).not.toHaveBeenCalled();
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
    const report = fakeMessage(FIXED, gzipReportMime(dmarcXml('a-corp.com')));
    await expect(handleHostedEmail(report, w.env as any)).rejects.toThrow(/INTAKE_DOMAIN/);
    expect(report.setReject).not.toHaveBeenCalled();
  });
});
