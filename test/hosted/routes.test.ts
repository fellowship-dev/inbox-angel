import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { call, makeEnv } from '../auth/helpers';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { hostedNames } from '../../src/hosted/records';
import { HOSTED_ENV, quiet } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const ZONE = 'zone-h';
const APEX = 'h.inboxangel.io';

async function setup() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const signup = async (email: string) => {
    const r = await call(env, 'POST', '/api/auth/signup', { body: { name: email, email, password: 'password-123' } });
    expect(r.status).toBe(201);
    const { token } = await r.json() as { token: string };
    const acct = rows('SELECT m.account_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].account_id as string;
    return { token, acct };
  };
  const A = await signup('a@example.com');
  const B = await signup('b@example.com');
  db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (1, ?, 'a-corp.com', 'x')").run(A.acct);
  db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (2, ?, 'b-corp.org', 'x')").run(B.acct);
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
    expect(t.rows('SELECT account_id FROM hosted_domains')).toEqual([{ account_id: t.A.acct }]);
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

describe('MTA-STS policy host', () => {
  const policyReq = (host: string) => new Request(`https://${host}/.well-known/mta-sts.txt`);

  it('resolves the tenant from the hosted id (and from the customer hostname), never from a default account', async () => {
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

    // the implicit account's config is not served on a hosted instance
    t.db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (9, 'acct_default', 'legacy.example', 'x')").run();
    t.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, account_id, mx_hosts, mode) VALUES (9, 'p', 'acct_default', 'mx.legacy.example', 'enforce')").run();
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
