// G1/G3: connecting a verified domain's reports to the fixed hosted address (rua@<INTAKE_DOMAIN>), through the real
// router and the real inbound path. No token, no records zone, no free-check domain.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { forWorkspace, resetSchemaReadyCache } from '@ready-set-mail/db';
import worker from '../../src/index';
import { handleHostedEmail } from '../../src/hosted/intake';
import { PEEK_BYTES, reportDomainCandidates, reportPrefix, scanPolicyDomain } from '../../src/hosted/fixed-address';
import { handleDmarcReport } from '../../src/email/dmarc-report';
import { loadTenant } from '../../src/tenancy/load';
import { reportIntakePreflightItems } from '../../src/hosted/report-intake-check';
import { generateToken, hashToken } from '../../src/hosted/tokens';
import { call, inviteAndAccept, makeEnv, signupVerified } from '../auth/helpers';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment, tlsRptJson, tlsRptMime, zipReportMime } from '../helpers/mail';
import { gzipSync, strToU8 } from 'fflate';
import { quiet } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const RUA = 'rua.readysetmail.com';
const FIXED = `rua@${RUA}`;
/** Report intake only: no records zone, no records token, no free-check domain. */
const INTAKE_ONLY = { MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar', OWNER_EMAIL: 'a-owner@example.com', HOSTED_CONNECT_REPORTS: 'all' };
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
/** A registry reporter's carrier (Google), so the report is COUNTED. */
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };

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
  const deliver = async (to: string, policyDomain: string, reportId: string, opts: Parameters<typeof fakeMessage>[2] = {}) => {
    const m = fakeMessage(to, gzipReportMime(dmarcXml(policyDomain, reportId)), opts);
    await handleHostedEmail(m, env as any);
    return m;
  };
  /** Stored reports; the id without its reporter-identity prefix (`google|…`, `~unauth|…`). */
  const stored = () => rows("SELECT workspace_id, domain_id, substr(report_id, instr(report_id, '|') + 1) AS report_id FROM aggregate_reports ORDER BY id");
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

    // An uncounted report (no authentication) does not make it "received"; a counted one does.
    expect((await w.deliver(FIXED, 'a-corp.com', 'uncounted-first')).setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ state: 'waiting', counted_since_connect: 0, reports_since_connect: 1 });
    const m = fakeMessage(FIXED, gzipReportMime(dmarcXml('a-corp.com', 'first-report')), GOOGLE);
    await worker.email(m, w.env as any, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ state: 'receiving', last_report_at: expect.any(Number) });
    expect(w.stored()).toEqual([{ workspace_id: w.A.ws, domain_id: 1, report_id: 'uncounted-first' }, { workspace_id: w.A.ws, domain_id: 1, report_id: 'first-report' }]);
    expect(w.rows("SELECT reporter_tier FROM aggregate_reports ORDER BY id").map((r) => r.reporter_tier)).toEqual(['unauthenticated', 'counted']);
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
    expect(body.dns.plan).toMatchObject({ kind: 'inherited', from: 'a-corp.com', policy: 'reject', own: { kind: 'add', name: '_dmarc.mail.a-corp.com', record: `v=DMARC1; p=reject; rua=mailto:${FIXED}` } });
    expect(body.parent).toEqual({ domain_id: 1, domain: 'a-corp.com', connected: false });
    await w.connect(1);
    expect((await w.status(5)).parent).toEqual({ domain_id: 1, domain: 'a-corp.com', connected: true });
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
    expect(late.setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    expect(w.stored().map(r => r.report_id)).toEqual(['kept']);
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
      expect(m.setReject, d).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
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
    expect(m.setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address'); // B owns it and has not connected
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
    // An older token address has no connection time: its reports count as before this connection, never as "received".
    expect(await w.status(1)).toMatchObject({ address: `rua+${token}@${RUA}`, state: 'not_published', reports_since_connect: 0, reports_before_connect: 1 });
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
    expect(legacy.body.error).toBe('Ownership of legacy-a.com is not proven in this workspace. Remove it and add it again to prove that you control it, then connect reports.');
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
    const check = fakeMessage('check+abcdefghijklmnopqrstuvwxyz234567@canary.readysetmail.com', 'Subject: hi\r\n\r\nhello');
    await handleHostedEmail(check, w.env as any);
    expect(check.setReject).toHaveBeenCalledWith('Unknown recipient');
    const session = await call(w.env, 'POST', '/api/check-sessions', { body: {} });
    expect(session.status).toBe(503);
    expect(await session.json()).toEqual({ error: 'The email check is not available here: no address is set up to receive the test email.' });
  });

  it('CANARY_DOMAIN alone: the free check still takes its mail; report mail is deferred (the sender retries) until INTAKE_DOMAIN is set', async () => {
    const w = await world({ INTAKE_DOMAIN: '', CANARY_DOMAIN: 'canary.readysetmail.com' });
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

const xmlWith = (policyBlock: string, records = '') => `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>google.com</org_name><email>noreply@google.com</email><report_id>${Math.random().toString(36).slice(2)}</report_id>
    <date_range><begin>1529366400</begin><end>1529452799</end></date_range></report_metadata>
  <policy_published>${policyBlock}<adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>
  ${records}
</feedback>`;
const record = (headerFrom: string) => `<record><row><source_ip>199.230.200.36</source_ip><count>3</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>${headerFrom}</header_from></identifiers><auth_results><spf><domain>${headerFrom}</domain><result>pass</result></spf></auth_results></record>`;

describe('review blockers (fixed address)', () => {
  it('1a. the reviewer’s quadratic input (29,127 opening policy_published tags, gzipped) is refused in milliseconds', async () => {
    const w = await world();
    await w.connect(1);
    const hostile = gzipSync(strToU8('<?xml version="1.0"?><feedback>' + '<policy_published>'.repeat(29127)));
    const m = fakeMessage(FIXED, mimeWithAttachment(hostile, 'r.xml.gz', 'application/gzip'));
    const t0 = performance.now();
    await handleHostedEmail(m, w.env as any);
    const ms = performance.now() - t0;
    console.info(`[measure] quadratic input: ${hostile.length} B gzip, refused in ${ms.toFixed(1)} ms`);
    expect(m.setReject).toHaveBeenCalledWith('The report does not name the domain it is about');
    expect(ms).toBeLessThan(250); // was 28.9 s; a few ms in practice, with headroom for a loaded CI runner
    // The scanner alone, on a full 64 KiB of the same pattern, stays linear.
    const t1 = performance.now();
    expect(scanPolicyDomain('<feedback>' + '<policy_published>'.repeat(4000))).toBeNull();
    expect(performance.now() - t1).toBeLessThan(50);
    expect(w.stored()).toEqual([]);
    expect(w.rows('SELECT * FROM intake_usage')).toEqual([]);
  });

  it('1b. a decompression bomb costs at most the 64 KiB peek: inflation stops there', async () => {
    const w = await world();
    await w.connect(1);
    const bomb = gzipSync(new Uint8Array(24 * 1024 * 1024).fill(0x20), { level: 9 });
    const t0 = performance.now();
    const prefix = reportPrefix(bomb);
    const peekMs = performance.now() - t0;
    expect(prefix.length).toBe(PEEK_BYTES);
    const m = fakeMessage(FIXED, mimeWithAttachment(bomb, 'r.xml.gz', 'application/gzip'));
    const heap0 = process.memoryUsage().heapUsed;
    const t1 = performance.now();
    await handleHostedEmail(m, w.env as any);
    const ms = performance.now() - t1;
    const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
    console.info(`[measure] bomb: ${bomb.length} B gzip of 24 MiB; peek ${peekMs.toFixed(1)} ms; refused in ${ms.toFixed(1)} ms; heap delta ${heapMb.toFixed(1)} MB`);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(ms).toBeLessThan(250);
    expect(w.stored()).toEqual([]);
  });

  it('2. a subdomain admitted through its parent stops owning reports when the parent goes; the new owner of the parent gets them', async () => {
    const w = await world();
    await w.connect(1);
    await w.connect(5); // mail.a-corp.com, verified via parent
    expect((await call(w.env, 'DELETE', '/api/domains/1', { key: w.A.token })).status).toBe(204);
    expect(w.rows('SELECT verified_via FROM domains WHERE id = 5')).toEqual([{ verified_via: 'legacy' }]); // demoted at the source
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (9, ?, 'a-corp.com', ?, 'txt')").run(w.B.ws, FIXED);
    expect((await w.deliver(FIXED, 'mail.a-corp.com', 'after-move')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.B.ws, domain_id: 9, report_id: 'after-move' }]);
    expect(await w.status(5)).toMatchObject({ can_connect: false, address: null, state: 'not_connected' }); // the demoted row shows as refused, not connected
  });

  it('2c. a demoted subdomain row never receives reports, even when its workspace proves the parent again', async () => {
    const w = await world();
    await w.connect(1);
    await w.connect(5);
    expect((await call(w.env, 'DELETE', '/api/domains/1', { key: w.A.token })).status).toBe(204);
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (10, ?, 'a-corp.com', ?, 'txt')").run(w.A.ws, FIXED);
    expect((await w.deliver(FIXED, 'mail.a-corp.com', 'readded')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.A.ws, domain_id: 10, report_id: 'readded' }]); // under the proven parent, not the legacy row
  });

  it('2b. even without the source fix (a row left verified via a parent that is gone), intake and connect treat it as unproven', async () => {
    const w = await world();
    await w.connect(1);
    await w.connect(5);
    w.db.sqlite.prepare('DELETE FROM domains WHERE id = 1').run(); // bypasses the demotion
    expect(w.rows('SELECT verified_via FROM domains WHERE id = 5')).toEqual([{ verified_via: 'parent' }]);
    expect((await w.deliver(FIXED, 'mail.a-corp.com', 'orphan')).setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (9, ?, 'a-corp.com', ?, 'txt')").run(w.B.ws, FIXED);
    expect((await w.deliver(FIXED, 'mail.a-corp.com', 'to-b')).setReject).not.toHaveBeenCalled();
    expect(w.stored()).toEqual([{ workspace_id: w.B.ws, domain_id: 9, report_id: 'to-b' }]);
    w.db.sqlite.prepare("UPDATE domains SET rua_address = '' WHERE id = 5").run();
    const again = await w.connect(5);
    expect(again.res.status).toBe(403);
    expect(again.body.error).toMatch(/added through a parent domain that is no longer in this workspace/);
  });

  it('3. a comment-hidden domain cannot steer routing: the peek reads the real one; a peek/parse mismatch stores nothing', async () => {
    const w = await world();
    await w.connect(1);
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (7, ?, 'shop.a-corp.com', ?, 'txt')").run(w.B.ws, FIXED);
    const xml = xmlWith('<!--<domain>a-corp.com</domain>--><domain>shop.a-corp.com</domain>', record('shop.a-corp.com'));
    const m = fakeMessage(FIXED, gzipReportMime(xml));
    await handleHostedEmail(m, w.env as any);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT workspace_id, domain_id FROM aggregate_reports')).toEqual([{ workspace_id: w.B.ws, domain_id: 7 }]);
    // CDATA and processing instructions are read as a parser reads them.
    expect(scanPolicyDomain('<?xml version="1.0"?><feedback><policy_published><?pi <domain>x.com</domain>?><domain><![CDATA[a-corp.com]]></domain></policy_published></feedback>')).toBe('a-corp.com');
    expect(scanPolicyDomain('<!DOCTYPE feedback [<!ENTITY d "a-corp.com">]><feedback><policy_published><domain>&d;</domain></policy_published></feedback>')).toBeNull();
    // Should the full parse ever read another domain than the peek, the report is refused and nothing is stored.
    const tenant = await loadTenant(w.env as any, { workspaceId: w.A.ws });
    const mm = fakeMessage(FIXED, gzipReportMime(dmarcXml('a-corp.com', 'mismatch')));
    await handleDmarcReport(mm, tenant, { token: { id: 1, domain: 'a-corp.com' }, expectedDomain: 'mail.a-corp.com' });
    expect(mm.setReject).toHaveBeenCalledWith('The report names the domain it is about inconsistently');
    expect(w.rows("SELECT * FROM aggregate_reports WHERE report_id LIKE '%mismatch'")).toEqual([]);
  });

  it('4. a record about another domain (header_from) refuses the whole report, on the fixed address and on token addresses', async () => {
    const w = await world();
    await w.connect(1);
    const xml = xmlWith('<domain>a-corp.com</domain>', record('a-corp.com') + record('b-corp.org'));
    const m = fakeMessage(FIXED, gzipReportMime(xml));
    await handleHostedEmail(m, w.env as any);
    expect(m.setReject).toHaveBeenCalledWith('Report contains records about a domain other than its own');
    const token = generateToken();
    await forWorkspace(w.env.DB as any, w.A.ws).intake.set(5, await hashToken(token), Math.floor(Date.now() / 1000));
    const t = fakeMessage(`rua+${token}@${RUA}`, gzipReportMime(xmlWith('<domain>mail.a-corp.com</domain>', record('b-corp.org'))));
    await handleHostedEmail(t, w.env as any);
    expect(t.setReject).toHaveBeenCalledOnce();
    // a subdomain's records under its parent's report are fine
    const ok = fakeMessage(FIXED, gzipReportMime(xmlWith('<domain>a-corp.com</domain>', record('a-corp.com') + record('news.a-corp.com'))));
    await handleHostedEmail(ok, w.env as any);
    expect(ok.setReject).not.toHaveBeenCalled();
    expect(w.stored()).toHaveLength(1);
  });

  it('5. "received" needs a report since this connection AND the address in live DNS; earlier reports are counted apart', async () => {
    const w = await world();
    await w.connect(1);
    expect((await w.deliver(FIXED, 'a-corp.com', 'forged-or-early')).setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ state: 'not_published', reports_since_connect: 1, reports_before_connect: 0 }); // not in DNS: not "received"
    await w.disconnect(1);
    w.db.sqlite.prepare('UPDATE aggregate_reports SET created_at = created_at - 60').run();
    await w.connect(1);
    expect(await w.status(1)).toMatchObject({ state: 'not_published', reports_since_connect: 0, reports_before_connect: 1, last_report_at: null });
    txt['_dmarc.a-corp.com'] = [`v=DMARC1; p=none; rua=mailto:${FIXED}`];
    expect(await w.status(1)).toMatchObject({ state: 'waiting', reports_before_connect: 1 });
    expect((await w.deliver(FIXED, 'a-corp.com', 'after-uncounted')).setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ state: 'waiting', reports_since_connect: 1, counted_since_connect: 0, reports_before_connect: 1 });
    expect((await w.deliver(FIXED, 'a-corp.com', 'after', GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(await w.status(1)).toMatchObject({ state: 'receiving', reports_since_connect: 2, counted_since_connect: 1, reports_before_connect: 1 });
  });

  it('6. HOSTED_CONNECT_REPORTS=owner (the default): only the instance owner’s workspaces connect or receive', async () => {
    const w = await world({ HOSTED_CONNECT_REPORTS: '' });
    expect((await w.connect(1)).res.status).toBe(201); // A is OWNER_EMAIL's workspace
    const b = await w.connect(2, w.B.token);
    expect(b.res.status).toBe(403);
    expect(b.body.error).toBe("On this server, only the operator's workspaces can connect reports.");
    expect(await w.status(2, w.B.token)).toMatchObject({ can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports." });
    w.db.sqlite.prepare('UPDATE domains SET rua_address = ? WHERE id = 2').run(FIXED); // even if B were connected
    expect((await w.deliver(FIXED, 'b-corp.org', 'b-blocked')).setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    expect((await w.deliver(FIXED, 'a-corp.com', 'a-ok')).setReject).not.toHaveBeenCalled();
    const none = await world({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: '' });
    expect((await none.connect(1)).res.status).toBe(403);
  });

  it('6b. the setup check names the intake settings, never their values', () => {
    const env = (e: Record<string, string>) => ({ MODE: 'saas', SAAS_ENABLED: '1', ...e }) as any;
    expect(reportIntakePreflightItems(env({})).map(i => i.setting)).toEqual(['INTAKE_DOMAIN']);
    // Authentication, caps and dropped reports are PR 151's intake findings (intakeSetupFindings): not repeated here.
    expect(reportIntakePreflightItems(env({ INTAKE_DOMAIN: RUA, HOSTED_CONNECT_REPORTS: 'everyone' })).map(i => [i.id, i.severity, i.setting])).toEqual([
      ['intake', 'action', 'HOSTED_CONNECT_REPORTS'], ['intake', 'action', 'HOSTED_CONNECT_REPORTS, OWNER_EMAIL'],
    ]);
    expect(reportIntakePreflightItems(env({ INTAKE_DOMAIN: RUA, HOSTED_CONNECT_REPORTS: 'all' })).map(i => i.message)).toEqual(['HOSTED_CONNECT_REPORTS is "all": every verified workspace can connect reports to the shared address.']);
    expect(JSON.stringify(reportIntakePreflightItems(env({ INTAKE_DOMAIN: RUA, OWNER_EMAIL: 'secret-owner@x.test' })))).not.toContain('secret-owner');
    expect(reportIntakePreflightItems({ MODE: 'selfhost' } as any)).toEqual([]);
  });
});
