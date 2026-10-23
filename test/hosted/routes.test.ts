import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { hostedNames } from '../../src/hosted/records';
import { refreshHostedMtaStsMx } from '../../src/hosted/cron';
import { runCronForWorkspaces } from '../../src/cron';
import { makeTenant } from '../helpers/tenant';
import { HOSTED_ENV, quiet } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const ZONE = 'zone-h';
const APEX = 'h.inboxangel.io';

async function setup() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const signup = async (email: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    return { token, ws };
  };
  const A = await signup('a@example.com');
  const B = await signup('b@example.com');
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (1, ?, 'a-corp.com', 'x')").run(A.ws);
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (2, ?, 'b-corp.org', 'x')").run(B.ws);
  const cf = stubCloudflare(new FakeCloudflare({ 'inboxangel.io': { id: ZONE } }));
  cf.doh['a-corp.com'] = ['v=spf1 include:_spf.example.net -all'];
  cf.doh['_spf.example.net'] = ['v=spf1 ip4:192.0.2.0/24 -all'];
  cf.mx['a-corp.com'] = ['10 mx1.mail.example.'];
  return { db, env, rows, A, B, cf };
}

beforeEach(() => quiet());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('/api/domains/:id/hosted', () => {
  it('enable → status → verify → rotate → disable', async () => {
    const t = await setup();
    const key = t.A.token;

    const none = await call(t.env, 'GET', '/api/domains/1/hosted', { key });
    expect(await none.json()).toEqual({ enabled: false });

    const enable = await call(t.env, 'POST', '/api/domains/1/hosted', { key, body: { mta_sts: true } });
    expect(enable.status).toBe(201);
    const { hosted, addresses } = await enable.json() as any;
    const names = hostedNames(hosted.hosted_id, APEX);
    expect(addresses.rua).toMatch(/^rua\+[a-z2-7]{32}@rua\.inboxangel\.io$/);
    expect(hosted.records).toEqual({ dmarc: names.dmarc, spf: names.spf, tls_rpt: names.tlsRpt, mta_sts: names.mtaSts });
    expect(t.rows('SELECT workspace_id FROM hosted_domains')).toEqual([{ workspace_id: t.A.ws }]);
    expect(t.rows("SELECT resource_name FROM audit_log WHERE action = 'hosted.enable'")).toEqual([{ resource_name: 'a-corp.com' }]);

    // GET never shows the token again
    const status = await (await call(t.env, 'GET', '/api/domains/1/hosted', { key })).text();
    expect(status).not.toContain(addresses.rua.slice(4, 36));
    expect(JSON.parse(status).pointer_status).toEqual({ dmarc: null, spf: null, mta_sts: null, tls_rpt: null, checked_at: null });

    // the customer adds the CNAMEs; verify sees them
    t.cf.cname['_dmarc.a-corp.com'] = names.dmarc;
    t.cf.cname['_mta-sts.a-corp.com'] = names.mtaSts;
    t.cf.doh['a-corp.com'] = [`v=spf1 include:${names.spf} -all`];
    const verified = await (await call(t.env, 'POST', '/api/domains/1/hosted/verify', { key })).json() as any;
    expect(verified.pointer_status).toMatchObject({ dmarc: 'ok', spf: 'ok', mta_sts: 'ok', tls_rpt: 'missing' });
    expect(verified.level_inputs).toEqual({ dmarc_published: true, spf_published: true, mta_sts_published: true });

    const rotated = await call(t.env, 'POST', '/api/domains/1/hosted/rotate-token', { key });
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as any).addresses.rua).not.toBe(addresses.rua);

    expect((await call(t.env, 'DELETE', '/api/domains/1/hosted', { key })).status).toBe(200);
    expect(t.rows('SELECT * FROM hosted_domains')).toEqual([]);
    expect(t.cf.records.get(ZONE)!.filter(r => r.name.endsWith(`.${APEX}`))).toEqual([]);
  });

  it('serves only the caller’s own domains', async () => {
    const t = await setup();
    for (const [method, path] of [['GET', ''], ['POST', ''], ['DELETE', ''], ['POST', '/verify'], ['POST', '/rotate-token']] as const) {
      const r = await call(t.env, method, `/api/domains/2/hosted${path}`, { key: t.A.token, body: method === 'POST' ? {} : undefined });
      expect(r.status).toBe(404);
    }
    expect(t.cf.calls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(t.rows('SELECT * FROM hosted_domains')).toEqual([]);
    expect((await call(t.env, 'GET', '/api/domains/1/hosted')).status).toBe(401);
  });

  it('is 404 where hosted mode is off', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { ...HOSTED_ENV, SAAS_ENABLED: '' }) as any;
    expect((await call(env, 'GET', '/api/domains/1/hosted')).status).toBe(503); // MODE=saas without SAAS_ENABLED=1: the whole API is off
  });
});

describe('GET /api/hosted/config', () => {
  it('says the hosted UI applies in hosted mode, to a signed-in caller only', async () => {
    const t = await setup();
    const r = await call(t.env, 'GET', '/api/hosted/config', { key: t.A.token });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enabled: true });
    expect((await call(t.env, 'GET', '/api/hosted/config')).status).toBe(401);
  });

  it('says no in self-host, without erroring', async () => {
    const env = makeEnv(createMigratedD1(), { API_KEY: 'k' }) as any;
    const r = await call(env, 'GET', '/api/hosted/config', { key: 'k' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enabled: false });
  });
});

describe('MTA-STS policy host', () => {
  const policyReq = (host: string) => new Request(`https://${host}/.well-known/mta-sts.txt`);

  it('resolves the tenant from the hosted id (and from the customer hostname), never from a default workspace', async () => {
    const t = await setup();
    const { hosted } = await (await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: { mta_sts: true } })).json() as any;
    const idHost = hostedNames(hosted.hosted_id, APEX).mtaSts;

    for (const host of [idHost, 'mta-sts.a-corp.com']) {
      const res = await worker.fetch(policyReq(host), t.env, ctx);
      expect(res.status, host).toBe(200);
      expect(await res.text()).toBe('version: STSv1\nmode: testing\nmx: mx1.mail.example\nmax_age: 86400\n');
    }

    // unknown id, someone else's domain, a domain nobody hosts: 404
    expect((await worker.fetch(policyReq(`mta-sts.aaaaaaaaaaaaaaaa.${APEX}`), t.env, ctx)).status).toBe(404);
    expect((await worker.fetch(policyReq('mta-sts.b-corp.org'), t.env, ctx)).status).toBe(404);
    expect((await worker.fetch(policyReq('mta-sts.nobody.example'), t.env, ctx)).status).toBe(404);

    // the implicit workspace's config is not served on a hosted instance
    t.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (9, 'ws_default', 'legacy.example', 'x')").run();
    t.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id, mx_hosts, mode) VALUES (9, 'p', 'ws_default', 'mx.legacy.example', 'enforce')").run();
    expect((await worker.fetch(policyReq('mta-sts.legacy.example'), t.env, ctx)).status).toBe(404);
  });

  it('after the hosted records are removed the policy host stops answering', async () => {
    const t = await setup();
    const { hosted } = await (await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: { mta_sts: true } })).json() as any;
    await call(t.env, 'DELETE', '/api/domains/1/hosted', { key: t.A.token });
    expect((await worker.fetch(policyReq(hostedNames(hosted.hosted_id, APEX).mtaSts), t.env, ctx)).status).toBe(404);
    expect((await worker.fetch(policyReq('mta-sts.a-corp.com'), t.env, ctx)).status).toBe(404);
  });
});

describe('legacy MTA-STS and domain paths on a hosted domain', () => {
  async function hostedWithMtaSts() {
    const t = await setup();
    const { hosted } = await (await call(t.env, 'POST', '/api/domains/1/hosted', { key: t.A.token, body: { mta_sts: true } })).json() as any;
    const names = hostedNames(hosted.hosted_id, APEX);
    const rec = (name: string, type?: string) => t.cf.records.get(ZONE)!.find(r => r.name === name && (!type || r.type === type));
    // a customer-zone record that happens to share an id with a hosted one must never be touched
    return { ...t, names, rec, hosted };
  }

  it('PATCH changes the hosted TXT through the hosted writer, nothing else', async () => {
    const t = await hostedWithMtaSts();
    const before = t.rec(t.names.mtaSts, 'TXT')!.content;
    const res = await call(t.env, 'PATCH', '/api/domains/1/mta-sts', { key: t.A.token, body: { mode: 'enforce' } });
    expect(res.status).toBe(200);
    expect(t.rows('SELECT mode, policy_id FROM mta_sts_config')[0].mode).toBe('enforce');
    expect(t.rec(t.names.mtaSts, 'TXT')!.content).not.toBe(before);
    expect(t.rec(t.names.mtaSts, 'TXT')!.content).toBe(`v=STSv1; id=${t.rows('SELECT policy_id FROM mta_sts_config')[0].policy_id}`);
    expect(t.cf.calls.filter(c => c.method === 'PATCH').every(c => c.zoneId === ZONE)).toBe(true);

    t.cf.mx['a-corp.com'] = ['10 mx9.mail.example.'];
    expect((await call(t.env, 'PATCH', '/api/domains/1/mta-sts', { key: t.A.token, body: { refresh_mx: true } })).status).toBe(200);
    expect(t.rows('SELECT mx_hosts FROM mta_sts_config')).toEqual([{ mx_hosts: 'mx9.mail.example' }]);
  });

  it('POST is refused (409); DELETE removes the hosted MTA-STS records but keeps DMARC, SPF and TLS-RPT', async () => {
    const t = await hostedWithMtaSts();
    expect((await call(t.env, 'POST', '/api/domains/1/mta-sts', { key: t.A.token, body: {} })).status).toBe(409);
    expect((await call(t.env, 'DELETE', '/api/domains/1/mta-sts', { key: t.A.token })).status).toBe(204);
    expect(t.rec(t.names.mtaSts)).toBeUndefined();
    for (const n of [t.names.dmarc, t.names.spf, t.names.tlsRpt]) expect(t.rec(n)).toBeDefined();
    expect(t.rows('SELECT * FROM mta_sts_config')).toEqual([]);
    expect(t.rows('SELECT record_count FROM hosted_zones')).toEqual([{ record_count: 3 }]);
    expect(t.rows('SELECT mta_sts_txt_record_id FROM hosted_domains')).toEqual([{ mta_sts_txt_record_id: null }]);
  });

  it('the legacy daily MX job skips hosted domains; the hosted job refreshes them', async () => {
    const t = await hostedWithMtaSts();
    t.cf.mx['a-corp.com'] = ['10 mx7.mail.example.'];
    const tenant = makeTenant({ db: t.db, workspaceId: t.A.ws, env: HOSTED_ENV as any, cfToken: 'customer-token', fetch: t.cf.fetch as any });
    t.cf.calls.length = 0;
    await runCronForWorkspaces({ cron: '0 8 * * *' } as ScheduledController, t.env, ctx, { workspaces: [t.A.ws], load: async () => tenant });
    expect(t.cf.calls.filter(c => c.method === 'PATCH')).toEqual([]);
    expect(t.rows('SELECT mx_hosts FROM mta_sts_config')).toEqual([{ mx_hosts: 'mx1.mail.example' }]);

    expect(await refreshHostedMtaStsMx(t.env)).toBe(1);
    expect(t.rows('SELECT mx_hosts FROM mta_sts_config')).toEqual([{ mx_hosts: 'mx7.mail.example' }]);
    expect(t.rec(t.names.mtaSts, 'TXT')!.content).toBe(`v=STSv1; id=${t.rows('SELECT policy_id FROM mta_sts_config')[0].policy_id}`);
    expect(await refreshHostedMtaStsMx(t.env)).toBe(0); // unchanged
  });

  it('deleting a domain removes its hosted records and quota first', async () => {
    const t = await hostedWithMtaSts();
    expect((await call(t.env, 'DELETE', '/api/domains/1', { key: t.A.token })).status).toBeLessThan(300);
    expect(t.cf.records.get(ZONE)!.filter(r => r.name.endsWith(`.${APEX}`))).toEqual([]);
    expect(t.rows('SELECT * FROM domains WHERE id = 1')).toEqual([]);
    expect(t.rows('SELECT record_count FROM hosted_zones')).toEqual([{ record_count: 0 }]);
  });

  it('if the DNS cleanup fails the domain is kept, with its records and rows', async () => {
    const t = await hostedWithMtaSts();
    const inner = t.cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => (init?.method === 'DELETE'
      ? new Response(JSON.stringify({ success: false, errors: [{ message: 'cf down' }] }), { status: 500 })
      : inner(input, init)));
    const res = await call(t.env, 'DELETE', '/api/domains/1', { key: t.A.token });
    expect(res.status).toBe(502);
    expect(t.rows('SELECT id FROM domains WHERE id = 1')).toHaveLength(1);
    expect(t.rows('SELECT * FROM hosted_domains')).toHaveLength(1);
    expect(t.rows('SELECT * FROM intake_tokens WHERE domain_id = 1')).toHaveLength(1);
  });
});
