import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalQueries, intakeLookups } from '@inbox-angel/db';
import { assertHostedName, HostedNameError, hostedNames, openHostedZone, retargetRua } from '../../src/hosted/records';
import { assessQuota, chooseZone, HostedQuotaError, PRO_RECORD_LIMIT, QUOTA_WARN_AT } from '../../src/hosted/zones';
import { reconcileZones, refreshHostedSpf } from '../../src/hosted/cron';
import { disableHosted, enableHosted, HostedError, hostedStatus, rotateHostedToken } from '../../src/hosted/service';
import { hashToken } from '../../src/hosted/tokens';
import { makeTenant } from '../helpers/tenant';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { dnsFrom } from './dns';
import { HOSTED_ENV, NOW, quiet, twoAccounts } from './world';

const CFG = { recordsZone: 'inboxangel.io', recordsLabel: 'h' };

beforeEach(() => quiet());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('record name guard', () => {
  it('accepts names strictly below h.inboxangel.io', () => {
    for (const n of ['abc._dmarc.h.inboxangel.io', 'mta-sts.abc.h.inboxangel.io', 'ABC._SPF.H.INBOXANGEL.IO', 'x.h.inboxangel.io']) {
      expect(assertHostedName(n, CFG)).toBe(n.toLowerCase());
    }
  });

  it.each([
    'inboxangel.io', 'h.inboxangel.io', 'www.inboxangel.io', '_dmarc.inboxangel.io', 'abc._dmarc.inboxangel.io',
    'x.h.inboxangel.io.evil.com', 'evilh.inboxangel.io', 'x.evilh.inboxangel.io', 'xh.inboxangel.io', 'x.h.inboxangel.io.', ' x.h.inboxangel.io',
    '*.h.inboxangel.io', 'a..h.inboxangel.io', 'a/b.h.inboxangel.io', '-.h.inboxangel.io', 'x.h.other.io', '', 'x.hh.inboxangel.io',
  ])('refuses %j', name => {
    expect(() => assertHostedName(name, CFG)).toThrow(HostedNameError);
  });

  it('follows the configured label and zone', () => {
    expect(assertHostedName('a.hosted.example.net', { recordsZone: 'example.net', recordsLabel: 'hosted' })).toBe('a.hosted.example.net');
    expect(() => assertHostedName('a.h.example.net', { recordsZone: 'example.net', recordsLabel: 'hosted' })).toThrow(HostedNameError);
    expect(() => assertHostedName('a.h.inboxangel.io', { recordsZone: undefined, recordsLabel: 'h' })).toThrow(/not configured/);
  });
});

describe('writer', () => {
  const zones = { 'inboxangel.io': { id: 'zone-h' } };

  it('writes only with HOSTED_RECORDS_TOKEN, and refuses names outside *.h.inboxangel.io before any request', async () => {
    const cf = stubCloudflare(new FakeCloudflare(zones));
    const writer = await openHostedZone({ ...HOSTED_ENV }, 'inboxangel.io');
    const before = cf.calls.length;

    for (const name of ['www.inboxangel.io', 'inboxangel.io', 'x.h.inboxangel.io.evil.com', '_dmarc.inboxangel.io']) {
      await expect(writer.create({ type: 'TXT', name, content: 'v=DMARC1; p=none' })).rejects.toBeInstanceOf(HostedNameError);
    }
    await expect(writer.create({ type: 'CNAME', name: 'a.h.inboxangel.io', content: 'evil.example' })).rejects.toThrow(/TXT or AAAA/);
    await expect(writer.create({ type: 'MX', name: 'a.h.inboxangel.io', content: 'mx.example' })).rejects.toThrow(/TXT or AAAA/);
    expect(cf.calls.length).toBe(before); // nothing reached Cloudflare

    const ok = await writer.create({ type: 'TXT', name: 'abc._dmarc.h.inboxangel.io', content: 'v=DMARC1; p=none' });
    expect(ok.id).toBeTruthy();
    expect(cf.calls.every(c => c.auth === 'Bearer hosted-token')).toBe(true);
  });

  it('updates and deletes only records that sit at the expected hosted name', async () => {
    const cf = stubCloudflare(new FakeCloudflare(zones));
    const www = cf.seed('zone-h', { type: 'A', name: 'www.inboxangel.io', content: '192.0.2.1' });
    const mine = cf.seed('zone-h', { type: 'TXT', name: 'abc._dmarc.h.inboxangel.io', content: 'v=DMARC1; p=none' });
    const writer = await openHostedZone({ ...HOSTED_ENV }, 'inboxangel.io');

    // a wrong id never reaches another record, whatever name the caller claims
    await expect(writer.remove(www.id, 'abc._dmarc.h.inboxangel.io')).rejects.toThrow(/not abc\._dmarc/);
    await expect(writer.setContent(www.id, 'abc._dmarc.h.inboxangel.io', 'x')).rejects.toBeInstanceOf(HostedNameError);
    // and a name outside the label is refused even if the id is right
    await expect(writer.remove(www.id, 'www.inboxangel.io')).rejects.toBeInstanceOf(HostedNameError);
    await expect(writer.setContent(www.id, 'www.inboxangel.io', 'x')).rejects.toBeInstanceOf(HostedNameError);
    expect(cf.records.get('zone-h')!.find(r => r.id === www.id)).toMatchObject({ content: '192.0.2.1' });
    expect(cf.calls.filter(c => c.method !== 'GET' && c.zoneId === 'zone-h')).toEqual([]);

    await writer.setContent(mine.id, 'abc._dmarc.h.inboxangel.io', 'v=DMARC1; p=reject');
    expect(await writer.remove(mine.id, 'abc._dmarc.h.inboxangel.io')).toBe(true);
    expect(await writer.remove(mine.id, 'abc._dmarc.h.inboxangel.io')).toBe(false); // already gone
  });

  it('needs a token', async () => {
    stubCloudflare(new FakeCloudflare(zones));
    await expect(openHostedZone({ ...HOSTED_ENV, HOSTED_RECORDS_TOKEN: '' }, 'inboxangel.io')).rejects.toThrow(/not configured/);
  });

  it('pages through the whole zone', async () => {
    const cf = stubCloudflare(new FakeCloudflare(zones));
    for (let i = 0; i < 2300; i++) cf.seed('zone-h', { type: 'A', name: `r${i}.inboxangel.io`, content: '192.0.2.1' });
    const writer = await openHostedZone({ ...HOSTED_ENV }, 'inboxangel.io');
    expect(await writer.listAll()).toHaveLength(2300);
  });

  it('retargetRua keeps the policy and every other tag', () => {
    expect(retargetRua('v=DMARC1; p=quarantine; rua=mailto:rua+old@rua.inboxangel.io; adkim=s', 'rua+new@rua.inboxangel.io'))
      .toBe('v=DMARC1; p=quarantine; adkim=s; rua=mailto:rua+new@rua.inboxangel.io');
  });
});

describe('zone quota', () => {
  it('warns from 3,200 records and is full past 3,500', () => {
    expect([PRO_RECORD_LIMIT, QUOTA_WARN_AT]).toEqual([3500, 3200]);
    expect(assessQuota(3199).level).toBe('ok');
    expect(assessQuota(3200).level).toBe('warn');
    expect(assessQuota(3500).level).toBe('warn');
    expect(assessQuota(3497, 3).level).toBe('warn');
    expect(assessQuota(3498, 3).level).toBe('full');
    expect(assessQuota(3500, 1).level).toBe('full');
  });

  it('chooseZone logs a warning at 3,200 and refuses when the zone cannot take the records', async () => {
    const w = await twoAccounts();
    const q = globalQueries(w.env.DB);
    await q.hostedZones.upsert({ zone_key: 'z1', zone_id: 'zone-h', zone_name: 'inboxangel.io' });

    await q.hostedZones.setObserved('z1', 3199, 'd', NOW);
    await chooseZone(w.env, 3);
    expect(console.warn).not.toHaveBeenCalled();

    await q.hostedZones.setObserved('z1', 3200, 'd', NOW);
    expect((await chooseZone(w.env, 3)).quota.level).toBe('warn');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('3200/3500'));

    await q.hostedZones.setObserved('z1', 3498, 'd', NOW);
    await expect(chooseZone(w.env, 3)).rejects.toBeInstanceOf(HostedQuotaError);
    await expect(chooseZone({ ...w.env, HOSTED_RECORDS_ZONE: '' }, 3)).rejects.toThrow(/No hosted-records zone/);
  });
});

describe('hosted records for a domain', () => {
  const ZONE = 'zone-h';
  const SOURCE = 'v=spf1 include:_spf.example.net ip4:203.0.113.5 ~all';
  const resolver = dnsFrom({ '_spf.example.net': { TXT: ['v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.7 -all'] } });

  async function setup() {
    const w = await twoAccounts();
    const cf = stubCloudflare(new FakeCloudflare({ 'inboxangel.io': { id: ZONE } }));
    cf.seed(ZONE, { type: 'A', name: 'www.inboxangel.io', content: '192.0.2.1' });
    cf.seed(ZONE, { type: 'MX', name: 'inboxangel.io', content: '10 mx.example' });
    const tenant = (acct = 'acct_a') => makeTenant({ db: w.db, accountId: acct, env: HOSTED_ENV as any });
    const domain = async (id = 1, acct = 'acct_a') => (await tenant(acct).scope.domains.getById(id))!;
    return { w, cf, tenant, domain };
  }
  const zoneRecords = (cf: FakeCloudflare) => cf.records.get(ZONE)!;
  const outsiders = (cf: FakeCloudflare) => zoneRecords(cf).filter(r => !r.name.endsWith('.h.inboxangel.io')).map(r => `${r.type} ${r.name} ${r.content}`);

  it('enable writes DMARC, SPF and TLS-RPT under the single label, with an opaque id, and leaves the rest of the zone alone', async () => {
    const { w, cf, tenant, domain } = await setup();
    const outsidersBefore = outsiders(cf);
    const { hosted, addresses } = await enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver });

    const names = hostedNames(hosted.hosted_id, 'h.inboxangel.io');
    const created = zoneRecords(cf).filter(r => r.name.endsWith('.h.inboxangel.io'));
    expect(created.map(r => r.name).sort()).toEqual([names.dmarc, names.spf, names.tlsRpt].sort());
    expect(hosted.hosted_id).toMatch(/^[a-z2-7]{16}$/);
    expect(JSON.stringify(created)).not.toContain('a-corp'); // never the customer's domain
    expect(outsiders(cf)).toEqual(outsidersBefore);
    expect(cf.calls.filter(c => c.zoneId === ZONE && c.method !== 'GET').every(c => c.method === 'POST')).toBe(true);
    expect(cf.calls.every(c => c.auth === 'Bearer hosted-token')).toBe(true);

    const byName = Object.fromEntries(created.map(r => [r.name, r.content]));
    expect(byName[names.dmarc]).toBe(`v=DMARC1; p=none; rua=mailto:${addresses.rua}`);
    expect(byName[names.tlsRpt]).toBe(`v=TLSRPTv1; rua=mailto:${addresses.tls_rpt}`);
    expect(byName[names.spf]).toBe('v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.7 ip4:203.0.113.5 ~all');
    expect(addresses.rua).toMatch(/^rua\+[a-z2-7]{32}@rua\.inboxangel\.io$/);

    // the address in the record resolves back to this domain; only its hash is stored
    const token = addresses.rua.slice(4, 36);
    expect(await intakeLookups(w.db as any).resolveToken(await hashToken(token), NOW)).toMatchObject({ account_id: 'acct_a', domain: 'a-corp.com' });
    expect(JSON.stringify(w.rows('SELECT * FROM intake_tokens'))).not.toContain(token);
    expect(w.rows("SELECT record_count FROM hosted_zones WHERE zone_key = 'z1'")).toEqual([{ record_count: 3 }]);

    expect(hosted.pointers.map(p => `${p.type} ${p.name} ${p.value}`)).toEqual([
      `CNAME _dmarc.a-corp.com ${names.dmarc}`,
      `TXT a-corp.com include:${names.spf}`,
      `CNAME _smtp._tls.a-corp.com ${names.tlsRpt}`,
    ]);
    expect(hosted.level_inputs).toEqual({ dmarc_published: false, spf_published: false, mta_sts_published: false });
  });

  it('enable with MTA-STS also hosts the policy records and a testing-mode config', async () => {
    const { w, cf, tenant, domain } = await setup();
    cf.mx['a-corp.com'] = ['10 mx1.mail.example.'];
    const { hosted } = await enableHosted(tenant(), await domain(), { spfRecord: SOURCE, mtaSts: true }, { resolver });
    const names = hostedNames(hosted.hosted_id, 'h.inboxangel.io');
    expect(zoneRecords(cf).filter(r => r.name === names.mtaSts).map(r => r.type).sort()).toEqual(['AAAA', 'TXT']);
    expect(w.rows('SELECT mode, mx_hosts, account_id FROM mta_sts_config')).toEqual([{ mode: 'testing', mx_hosts: 'mx1.mail.example', account_id: 'acct_a' }]);
    expect(hosted.pointers.map(p => p.purpose)).toContain('mta_sts');
    expect(w.rows("SELECT record_count FROM hosted_zones")).toEqual([{ record_count: 5 }]);
  });

  it('refuses a second enable, a full zone, and an SPF record it cannot resolve', async () => {
    const { w, cf, tenant, domain } = await setup();
    await enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver });
    await expect(enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver })).rejects.toMatchObject({ status: 409 });

    const d2 = await domain(2, 'acct_b');
    await expect(enableHosted(tenant('acct_b'), d2, { spfRecord: 'v=spf1 include:gone.example.net -all' }, { resolver })).rejects.toMatchObject({ status: 422 });
    expect(w.rows('SELECT * FROM hosted_domains WHERE domain_id = 2')).toEqual([]);

    const before = zoneRecords(cf).length;
    w.db.sqlite.prepare("UPDATE hosted_zones SET record_count = 3499 WHERE zone_key = 'z1'").run();
    await expect(enableHosted(tenant('acct_b'), d2, { spfRecord: SOURCE }, { resolver })).rejects.toMatchObject({ status: 507 });
    expect(zoneRecords(cf).length).toBe(before); // nothing written
  });

  it('is all-or-nothing: a Cloudflare failure part-way removes what was written and forgets the domain', async () => {
    const { w, cf, tenant, domain } = await setup();
    const inner = cf.fetch;
    vi.stubGlobal('fetch', async (input: any, init: any) => {
      if (init?.method === 'POST' && String(init.body).includes('TLSRPTv1')) return new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 });
      return inner(input, init);
    });
    await expect(enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver })).rejects.toMatchObject({ status: 502 });
    expect(zoneRecords(cf).filter(r => r.name.endsWith('.h.inboxangel.io'))).toEqual([]);
    for (const t of ['hosted_domains', 'intake_tokens']) expect(w.rows(`SELECT * FROM ${t}`).filter(r => r.domain_id === 1)).toEqual([]);
    expect(w.rows('SELECT record_count FROM hosted_zones')).toEqual([{ record_count: 0 }]);
  });

  it('rotate retargets the hosted records (policy kept); the old token keeps working for the grace period only', async () => {
    const { w, cf, tenant, domain } = await setup();
    const { hosted, addresses } = await enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver });
    const names = hostedNames(hosted.hosted_id, 'h.inboxangel.io');
    zoneRecords(cf).find(r => r.name === names.dmarc)!.content = `v=DMARC1; p=quarantine; rua=mailto:${addresses.rua}; adkim=s`; // advanced since

    const next = await rotateHostedToken(tenant(), await domain(), {}, undefined, undefined);
    expect(next.rua).not.toBe(addresses.rua);
    const dmarc = zoneRecords(cf).find(r => r.name === names.dmarc)!.content;
    expect(dmarc).toBe(`v=DMARC1; p=quarantine; adkim=s; rua=mailto:${next.rua}`);
    expect(zoneRecords(cf).find(r => r.name === names.tlsRpt)!.content).toBe(`v=TLSRPTv1; rua=mailto:${next.tls_rpt}`);

    const look = intakeLookups(w.db as any);
    const old = addresses.rua.slice(4, 36);
    const fresh = next.rua.slice(4, 36);
    expect((await look.resolveToken(await hashToken(fresh), NOW))?.account_id).toBe('acct_a');
    expect((await look.resolveToken(await hashToken(old), Math.floor(Date.now() / 1000)))?.account_id).toBe('acct_a');
    expect(await look.resolveToken(await hashToken(old), Math.floor(Date.now() / 1000) + 73 * 3600)).toBeNull();
  });

  it('disable removes the records and the rows, and nothing else', async () => {
    const { w, cf, tenant, domain } = await setup();
    const outsidersBefore = outsiders(cf);
    await enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver });
    await disableHosted(tenant(), await domain());
    expect(zoneRecords(cf).map(r => `${r.type} ${r.name} ${r.content}`).sort()).toEqual(outsidersBefore.sort());
    expect(w.rows('SELECT * FROM hosted_domains')).toEqual([]);
    expect(w.rows("SELECT * FROM intake_tokens WHERE domain_id = 1")).toEqual([]);
    expect(w.rows('SELECT record_count FROM hosted_zones')).toEqual([{ record_count: 0 }]);
    expect(await hostedStatus(tenant(), await domain())).toBeNull();
    await expect(disableHosted(tenant(), await domain())).rejects.toBeInstanceOf(HostedError);
  });

  it('the daily SPF refresh follows the provider’s ranges; an unresolvable source keeps yesterday’s record', async () => {
    const { w, cf, tenant, domain } = await setup();
    const { hosted } = await enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver });
    const spfName = hostedNames(hosted.hosted_id, 'h.inboxangel.io').spf;
    const content = () => zoneRecords(cf).find(r => r.name === spfName)!.content;
    expect(content()).toBe('v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.7 ip4:203.0.113.5 ~all');

    expect(await refreshHostedSpf(w.env, { resolver })).toEqual({ updated: 0, failed: 0 }); // unchanged: no write
    expect(cf.calls.filter(c => c.method === 'PATCH')).toEqual([]);

    const moved = dnsFrom({ '_spf.example.net': { TXT: ['v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.200 -all'] } });
    expect(await refreshHostedSpf(w.env, { resolver: moved })).toEqual({ updated: 1, failed: 0 });
    expect(content()).toBe('v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.200 ip4:203.0.113.5 ~all');

    const broken = dnsFrom({ '_spf.example.net': { error: true } });
    expect(await refreshHostedSpf(w.env, { resolver: broken })).toEqual({ updated: 0, failed: 1 });
    expect(content()).toBe('v=spf1 ip4:192.0.2.0/24 ip4:198.51.100.200 ip4:203.0.113.5 ~all');
  });

  it('daily reconcile counts the whole zone, reports drift, flags changes outside the label, and writes nothing', async () => {
    const { w, cf, tenant, domain } = await setup();
    const { hosted } = await enableHosted(tenant(), await domain(), { spfRecord: SOURCE }, { resolver });
    const names = hostedNames(hosted.hosted_id, 'h.inboxangel.io');
    for (let i = 0; i < 3200; i++) cf.seed(ZONE, { type: 'A', name: `bulk${i}.inboxangel.io`, content: '192.0.2.9' });
    cf.seed(ZONE, { type: 'TXT', name: 'stray.h.inboxangel.io', content: 'nobody owns this' });
    const spf = zoneRecords(cf).find(r => r.name === names.spf)!;
    cf.records.set(ZONE, zoneRecords(cf).filter(r => r !== spf)); // someone deleted one of ours
    cf.calls.length = 0;

    const [first] = await reconcileZones(w.env);
    expect(first.quota).toMatchObject({ count: 2 + 3200 + 2 + 1, level: 'warn' }); // www, mx, bulk, ours (3 − the deleted one), stray
    expect(first.missing).toEqual([names.spf]);
    expect(first.orphans).toEqual(['stray.h.inboxangel.io']);
    expect(first.restChanged).toBe(false); // first run: nothing to compare with
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/holds \d+\/3500 records \(warn\)/));
    expect(cf.calls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(w.rows('SELECT record_count FROM hosted_zones')).toEqual([{ record_count: first.quota.count }]);

    expect((await reconcileZones(w.env))[0].restChanged).toBe(false);
    zoneRecords(cf).find(r => r.name === 'www.inboxangel.io')!.content = '198.51.100.99';
    expect((await reconcileZones(w.env))[0].restChanged).toBe(true);
    expect(cf.calls.filter(c => c.method !== 'GET')).toEqual([]); // still read-only
  });
});
