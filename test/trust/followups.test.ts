// Follow-ups: evicting a legacy domain holder safely, and invitees who sign up through an invite.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, signupVerified, ctx } from '../auth/helpers';
import { handleApi } from '../../src/api/router';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { HOSTED_ENV } from '../hosted/world';
import { runRetention } from '../../src/lifecycle/retention';

const json = async (r: Response) => await r.json() as any;
afterEach(() => vi.restoreAllMocks());

async function world() {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send } });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const mk = async (email: string, reports: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', ?)").run(ws, reports);
    return { token, ws };
  };
  const A = await mk('a@example.com', 'reports.a.test');
  const B = await mk('b@example.com', 'reports.b.test');
  const cf = stubCloudflare(new FakeCloudflare({ 'inboxangel.io': { id: 'zone-h' } }));
  send.mockClear();
  return { db, env, send, rows, A, B, cf };
}

describe('evicting a legacy holder', () => {
  async function evicted() {
    const w = await world();
    const ins = w.db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id, verified_via, dns_record_id) VALUES (50, 'acme.com', 'x', ?, 'legacy', 'rec-auth')").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, workspace_id) VALUES (500, 50, 'Google', 'r1', unixepoch() - 86400, unixepoch(), ?)").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, workspace_id) VALUES (500, '1.2.3.4', 5, 'none', ?)").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO intake_tokens (domain_id, workspace_id, token_hash) VALUES (50, ?, 'h')").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key, dmarc_record_id) VALUES (50, ?, 'hid', 'z1', 'rec-dmarc')").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO hosted_zones (zone_key, zone_id, zone_name, record_count) VALUES ('z1', 'zone-h', 'inboxangel.io', 3)").run();
    w.cf.seed('zone-h', { id: 'rec-dmarc', type: 'TXT', name: 'hid._dmarc.h.inboxangel.io', content: 'v=DMARC1; p=none' });
    const { claim } = await json(await call(w.env, 'POST', '/api/domains', { key: w.B.token, body: { domain: 'acme.com' } }));
    w.cf.doh['_inboxangel.acme.com'] = [claim.txt_value];
    const res = await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: w.B.token, body: {} });
    await new Promise(r => setTimeout(r, 30));
    return { w, res };
  }

  it('goes through the removal path (hosted records), detaches the row instead of deleting it, and keeps the history', async () => {
    const { w, res } = await evicted();
    expect(res.status).toBe(201);
    expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'acme.com'")).toEqual([{ workspace_id: w.B.ws }]);
    expect(w.rows('SELECT domain, evicted_name, evicted_at IS NOT NULL AS gone, alerts_enabled FROM domains WHERE id = 50')).toEqual([{ domain: 'evicted-50.invalid', evicted_name: 'acme.com', gone: 1, alerts_enabled: 0 }]);
    expect(w.rows('SELECT COUNT(*) n FROM hosted_domains WHERE domain_id = 50')).toEqual([{ n: 0 }]); // hosted records removed through disableHosted
    expect(w.cf.calls.some(c => c.method === 'DELETE' && /dns_records\/rec-dmarc/.test(c.url))).toBe(true);
    expect(w.rows('SELECT COUNT(*) n FROM intake_tokens WHERE domain_id = 50')).toEqual([{ n: 0 }]);
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports WHERE domain_id = 50')).toEqual([{ n: 1 }]); // history kept
    expect(w.rows('SELECT COUNT(*) n FROM report_records WHERE report_id = 500')).toEqual([{ n: 1 }]);
  });

  it('is hidden from the evicted workspace’s domain list, audit-logged, and its owners are emailed', async () => {
    const { w } = await evicted();
    const list = await json(await call(w.env, 'GET', '/api/domains', { key: w.A.token }));
    expect(list.domains).toEqual([]);
    expect(w.rows("SELECT action, resource_name FROM audit_log WHERE workspace_id = ? AND action = 'domain.evicted'", w.A.ws)).toEqual([{ action: 'domain.evicted', resource_name: 'acme.com' }]);
    const mails = w.send.mock.calls.map((c: any) => c[0]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: ['a@example.com'], subject: expect.stringMatching(/acme\.com was removed/) });
    expect(mails[0].text).toMatch(/30 days/);
    expect(mails[0].text).not.toContain('b@example.com'); // the winner is not named
  });

  it('keeps the history exportable for 30 days, then the retention job purges it', async () => {
    const { w } = await evicted();
    const env = w.env as any;
    const day = 86400;
    const soon = await runRetention(env, { now: () => (Math.floor(Date.now() / 1000) + 29 * day) * 1000 });
    expect(soon.evicted_domains).toBe(0);
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports WHERE domain_id = 50')).toEqual([{ n: 1 }]);
    const later = await runRetention(env, { now: () => (Math.floor(Date.now() / 1000) + 31 * day) * 1000 });
    expect(later.evicted_domains).toBe(1);
    expect(w.rows('SELECT COUNT(*) n FROM domains WHERE id = 50')).toEqual([{ n: 0 }]);
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports WHERE domain_id = 50')).toEqual([{ n: 0 }]);
    expect(w.rows('SELECT COUNT(*) n FROM report_records WHERE report_id = 500')).toEqual([{ n: 0 }]);
  });

  it('a cleanup failure does not keep the rightful owner out; the audit entry says so', async () => {
    const w = await world();
    w.db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id, verified_via) VALUES (50, 'acme.com', 'x', ?, 'legacy')").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key, dmarc_record_id) VALUES (50, ?, 'hid', 'z1', 'rec-dmarc')").run(w.A.ws);
    w.cf.failWith = { status: 500, message: 'down' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { claim } = await json(await call(w.env, 'POST', '/api/domains', { key: w.B.token, body: { domain: 'acme.com' } }));
    w.cf.doh['_inboxangel.acme.com'] = [claim.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: w.B.token, body: {} })).status).toBe(201);
    await new Promise(r => setTimeout(r, 30));
    expect(w.rows("SELECT meta FROM audit_log WHERE action = 'domain.evicted'").map(r => JSON.parse(r.meta).hosted_cleanup)).toEqual(['failed']);
  });
});

describe('signing up through an invite (hosted)', () => {
  it('creates no personal workspace; after verifying, the session shows the pending invite, and accepting joins the inviting workspace', async () => {
    const w = await world();
    const inv = await json(await call(w.env, 'POST', '/api/team/invite', { key: w.A.token, body: { email: 'friend@example.com' } }));
    const before = w.rows("SELECT COUNT(*) n FROM workspaces").at(0).n;
    expect((await call(w.env, 'POST', `/api/invites/${inv.token}`, { body: { name: 'Friend', password: 'password-123' } })).status).toBe(201);
    expect(w.rows('SELECT COUNT(*) n FROM workspaces')[0].n).toBe(before); // no new workspace
    // verify (as the emailed link would), choose a password, sign in
    const link = new URL(((w.send.mock.calls.at(-1) as any)[0].text as string).match(/https?:\/\/\S+verify-email\S+/)![0]);
    const verified = await handleApi(new Request(`https://ia.example.com${link.pathname}${link.search}`), w.env, ctx);
    const reset = await call(w.env, 'POST', '/api/auth/reset', { body: { token: verified.headers.get('location')!.split('/').pop(), password: 'chosen-password-1' } });
    const session = (await json(reset)).token as string;
    const me = await call(w.env, 'GET', '/api/me', { key: session });
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ role: null, workspace_id: null, pending_invites: [{ token: inv.token, workspace_id: w.A.ws, role: 'member' }] });
    expect((await call(w.env, 'GET', '/api/domains', { key: session })).status).toBe(403); // nothing else is open to them yet
    expect((await call(w.env, 'POST', `/api/invites/${inv.token}`, { key: session, body: {} })).status).toBe(200);
    expect(await json(await call(w.env, 'GET', '/api/me', { key: session }))).toMatchObject({ role: 'member', workspace_id: w.A.ws });
  });

  it('the invite is still needed: without one a no-workspace sign-up through this path is refused', async () => {
    const w = await world();
    expect((await call(w.env, 'POST', '/api/invites/not-a-token', { body: { name: 'X', password: 'password-123' } })).status).toBe(404);
  });
});

describe('detached (evicted) domains are invisible everywhere except export', () => {
  async function withEvicted() {
    const w = await world();
    const { forWorkspace } = await import('@inbox-angel/db');
    const ins = w.db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, workspace_id, verified_via, evicted_at, evicted_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run(60, 'live.com', 'x', w.A.ws, 'txt', null, null);
    ins.run(61, 'evicted-61.invalid', 'x', w.A.ws, 'legacy', 1700000000, 'gone.com');
    for (const [rid, did, rep] of [[600, 60, 'live-r'], [601, 61, 'gone-r']] as const) {
      w.db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id) VALUES (?, ?, 'Google', ?, unixepoch() - 86400, unixepoch(), 10, 5, 5, ?)").run(rid, did, rep, w.A.ws);
      w.db.sqlite.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, spf_result, header_from, workspace_id) VALUES (?, ?, 10, 'none', 'fail', 'fail', 'x', ?)").run(rid, did === 60 ? '198.51.100.1' : '198.51.100.99', w.A.ws);
    }
    return { w, q: forWorkspace(w.env.DB, w.A.ws) };
  }

  it('lists, report queries, analytics, digest stats and heartbeat counts skip them', async () => {
    const { w, q } = await withEvicted();
    expect((await q.domains.list()).map(d => d.domain)).toEqual(['live.com']);
    expect(await q.domains.getById(61)).toBeNull();
    expect((await q.reports.recent()).map(r => r.report_id ?? r.org_name)).toHaveLength(1);
    expect(await q.reports.getWithDomain(601)).toBeNull();
    expect(await q.reports.getWithDomain(600)).not.toBeNull();
    expect((await q.analytics.domainTotals(0)).map(d => d.domain)).toEqual(['live.com']);
    expect((await q.reports.weeklyDomainStats(0)).map(d => d.domain)).toEqual(['live.com']);
    const senders = JSON.stringify(await q.analytics.senderRows(null, 0, 0, Math.floor(Date.now() / 1000)));
    expect(senders).toContain('198.51.100.1');
    expect(senders).not.toContain('198.51.100.99');
    const hb = await q.heartbeat();
    expect(JSON.stringify(hb)).not.toMatch(/"domains":2/);
    // the API says the same
    const res = await call(w.env, 'GET', '/api/domains', { key: w.A.token });
    expect((await json(res)).domains.map((d: any) => d.domain)).toEqual(['live.com']);
    expect((await call(w.env, 'GET', '/api/reports/601', { key: w.A.token })).status).toBe(404);
    expect(JSON.stringify(await json(await call(w.env, 'GET', '/api/analytics', { key: w.A.token })))).not.toContain('198.51.100.99');
  });

  it('but the export still has them (that is what the 30 days are for)', async () => {
    const { w } = await withEvicted();
    const { exportQueries } = await import('@inbox-angel/db');
    const rows = await exportQueries(w.env.DB as any, w.A.ws).paged.domains(0, 100);
    expect(rows.map((r: any) => r.evicted_name ?? r.domain).sort()).toEqual(['gone.com', 'live.com']);
  });
});

describe('subdomains go with an evicted parent', () => {
  it('children are cleaned up, detached and audited too; nothing stays live', async () => {
    const w = await world();
    const ins = w.db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id, verified_via, parent_id) VALUES (?, ?, 'x', ?, 'legacy', ?)");
    ins.run(70, 'acme.com', w.A.ws, null); ins.run(71, 'mail.acme.com', w.A.ws, 70); ins.run(72, 'eu.mail.acme.com', w.A.ws, 71);
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key, dmarc_record_id) VALUES (71, ?, 'hid71', 'z1', 'rec-71')").run(w.A.ws);
    w.db.sqlite.prepare("INSERT INTO hosted_zones (zone_key, zone_id, zone_name, record_count) VALUES ('z1', 'zone-h', 'inboxangel.io', 1)").run();
    w.cf.seed('zone-h', { id: 'rec-71', type: 'TXT', name: 'hid71._dmarc.h.inboxangel.io', content: 'v=DMARC1; p=none' });
    const { claim } = await json(await call(w.env, 'POST', '/api/domains', { key: w.B.token, body: { domain: 'acme.com' } }));
    w.cf.doh['_inboxangel.acme.com'] = [claim.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: w.B.token, body: {} })).status).toBe(201);
    await new Promise(r => setTimeout(r, 30));
    expect(w.rows('SELECT id, evicted_at IS NOT NULL AS gone FROM domains WHERE id IN (70, 71, 72) ORDER BY id')).toEqual([{ id: 70, gone: 1 }, { id: 71, gone: 1 }, { id: 72, gone: 1 }]);
    expect((await json(await call(w.env, 'GET', '/api/domains', { key: w.A.token }))).domains).toEqual([]);
    expect(w.rows('SELECT COUNT(*) n FROM hosted_domains WHERE domain_id = 71')).toEqual([{ n: 0 }]); // the child's hosted records were removed
    expect(w.cf.calls.some(c => c.method === 'DELETE' && /rec-71/.test(c.url))).toBe(true);
    expect(w.rows("SELECT COUNT(*) n FROM audit_log WHERE action = 'domain.evicted'")).toEqual([{ n: 3 }]);
    // and the purge removes the whole tree at once, leaving no orphaned parent_id
    const { runRetention } = await import('../../src/lifecycle/retention');
    await runRetention(w.env as any, { now: () => (Math.floor(Date.now() / 1000) + 31 * 86400) * 1000 });
    expect(w.rows('SELECT COUNT(*) n FROM domains WHERE id IN (70, 71, 72)')).toEqual([{ n: 0 }]);
  });
});

describe('a login with no workspace can start its own', () => {
  async function stranded() {
    const w = await world();
    const inv = await json(await call(w.env, 'POST', '/api/team/invite', { key: w.A.token, body: { email: 'friend@example.com' } }));
    await call(w.env, 'POST', `/api/invites/${inv.token}`, { body: { name: 'Friend', password: 'password-123' } });
    const link = new URL(((w.send.mock.calls.at(-1) as any)[0].text as string).match(/https?:\/\/\S+verify-email\S+/)![0]);
    const verified = await handleApi(new Request(`https://ia.example.com${link.pathname}${link.search}`), w.env, ctx);
    const session = (await json(await call(w.env, 'POST', '/api/auth/reset', { body: { token: verified.headers.get('location')!.split('/').pop(), password: 'chosen-password-1' } }))).token as string;
    // the owner revokes the invite
    const id = (await json(await call(w.env, 'GET', '/api/team/invites', { key: w.A.token }))).invites[0].id;
    expect((await call(w.env, 'DELETE', `/api/team/invites/${id}`, { key: w.A.token })).status).toBe(200);
    return { w, session };
  }

  it('POST /api/workspaces works for them, and then they are an ordinary owner', async () => {
    const { w, session } = await stranded();
    expect(await json(await call(w.env, 'GET', '/api/me', { key: session }))).toMatchObject({ workspace_id: null, pending_invites: [] });
    const made = await call(w.env, 'POST', '/api/workspaces', { key: session, body: { name: 'Friend Co' } });
    expect(made.status).toBe(201);
    expect(await json(await call(w.env, 'GET', '/api/me', { key: session }))).toMatchObject({ role: 'owner', workspace_id: (await json(made)).id });
  });

  it('only that route opens up: everything else stays closed, and a cookie session still needs a same-origin request', async () => {
    const { w, session } = await stranded();
    expect((await call(w.env, 'GET', '/api/domains', { key: session })).status).toBe(403);
    expect((await call(w.env, 'POST', '/api/domains', { key: session, body: { domain: 'x.example.net' } })).status).toBe(403);
    const login = await call(w.env, 'POST', '/api/auth/login', { headers: { origin: 'https://ia.example.com' }, body: { email: 'friend@example.com', password: 'chosen-password-1' } });
    const cookie = (login.headers as any).getSetCookie().map((c: string) => c.split(';')[0]).join('; ');
    const cross = await call(w.env, 'POST', '/api/workspaces', { headers: { cookie, origin: 'https://evil.example' }, body: { name: 'x' } });
    expect(cross.status).toBe(403);
    expect(w.rows("SELECT COUNT(*) n FROM workspaces WHERE name = 'x'")).toEqual([{ n: 0 }]);
  });

  it('an unverified or anonymous caller cannot', async () => {
    const w = await world();
    expect((await call(w.env, 'POST', '/api/workspaces', { body: { name: 'x' } })).status).toBe(401);
  });
});
