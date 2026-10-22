import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));

import { provisionMtaSts, deprovisionMtaSts, updateMtaStsTxtRecord, patchCfDnsRecord } from '../../src/email/mta-sts';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { makeTenant } from '../helpers/tenant';

afterEach(() => vi.unstubAllGlobals());

function world() {
  const cf = stubCloudflare(new FakeCloudflare({
    'acme.com': { id: 'zone-acme', accountId: 'cf' },
    'other-company.org': { id: 'zone-other', accountId: 'cf' },
  }));
  cf.mx['acme.com'] = ['10 mx.acme.com.'];
  cf.mx['other-company.org'] = ['10 mx.other-company.org.'];
  cf.routes['zone-acme'] = [{ pattern: 'inbox.acme.com/*', script: 'inbox-angel-worker' }];
  return cf;
}

const tenant = (settings: Record<string, string> = {}, env: Record<string, string> = {}) =>
  makeTenant({
    cfToken: 'tok', env: env as any,
    settings: { reportsDomain: 'reports.acme.com', zoneId: 'zone-acme', zoneName: 'acme.com', cfAccountId: 'cf', ...settings },
  });

describe('provisionMtaSts', () => {
  it('creates the three records in the zone of the domain being provisioned', async () => {
    const cf = world();
    const t = tenant({ workersSubdomain: 'fellowshipdev' });

    const a = await provisionMtaSts(t, 'acme.com');
    const b = await provisionMtaSts(t, 'other-company.org');

    expect(cf.records.get('zone-acme')!.map(r => r.name).sort()).toEqual(['_mta-sts.acme.com', '_smtp._tls.acme.com', 'mta-sts.acme.com']);
    expect(cf.records.get('zone-other')!.map(r => r.name).sort()).toEqual(['_mta-sts.other-company.org', '_smtp._tls.other-company.org', 'mta-sts.other-company.org']);
    expect(a.mx_hosts).toEqual(['mx.acme.com']);
    expect(b.mx_hosts).toEqual(['mx.other-company.org']);
  });

  it('points TLS-RPT at the tenant\'s reports domain', async () => {
    const cf = world();
    await provisionMtaSts(tenant({ workersSubdomain: 'x', reportsDomain: 'reports.acme.com' }), 'acme.com');
    const tlsrpt = cf.records.get('zone-acme')!.find(r => r.name === '_smtp._tls.acme.com')!;
    expect(tlsrpt.content).toBe('v=TLSRPTv1; rua=mailto:tls-rpt@reports.acme.com');
  });

  it('uses an existing route of the domain\'s zone as the CNAME target', async () => {
    const cf = world();
    await provisionMtaSts(tenant(), 'acme.com');
    expect(cf.records.get('zone-acme')!.find(r => r.type === 'CNAME')!.content).toBe('inbox.acme.com');
  });

  it('falls back to {worker}.{account subdomain}.workers.dev, not the bare {worker}.workers.dev', async () => {
    const cf = world();
    await provisionMtaSts(tenant({ workersSubdomain: 'fellowshipdev' }), 'other-company.org');
    expect(cf.records.get('zone-other')!.find(r => r.type === 'CNAME')!.content).toBe('inbox-angel-worker.fellowshipdev.workers.dev');
  });

  it('honours a custom WORKER_NAME in the fallback address', async () => {
    const cf = world();
    await provisionMtaSts(tenant({ workersSubdomain: 'fellowshipdev' }, { WORKER_NAME: 'my-angel' }), 'other-company.org');
    expect(cf.records.get('zone-other')!.find(r => r.type === 'CNAME')!.content).toBe('my-angel.fellowshipdev.workers.dev');
  });

  it('looks the workers.dev subdomain up when it is not stored', async () => {
    const cf = world();
    const original = cf.fetch.getMockImplementation()!;
    cf.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/accounts/cf/workers/subdomain')) return new Response(JSON.stringify({ success: true, result: { subdomain: 'looked-up' } }), { status: 200 });
      return original(input, init);
    });
    await provisionMtaSts(tenant(), 'other-company.org');
    expect(cf.records.get('zone-other')!.find(r => r.type === 'CNAME')!.content).toBe('inbox-angel-worker.looked-up.workers.dev');
  });

  it('refuses to publish a CNAME that cannot resolve when the subdomain is unknown', async () => {
    const cf = world();
    await expect(provisionMtaSts(tenant(), 'other-company.org')).rejects.toThrow(/Cannot determine the public hostname/);
    expect(cf.records.get('zone-other')).toBeUndefined();
  });

  it('writes nothing when the domain has no zone', async () => {
    const cf = world();
    cf.mx['unmanaged.net'] = ['10 mx.unmanaged.net.'];
    await expect(provisionMtaSts(tenant({ workersSubdomain: 'x' }), 'unmanaged.net')).rejects.toThrow(/No Cloudflare zone found for unmanaged\.net/);
    expect(cf.calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
});

describe('MTA-STS record updates and removal stay in the domain\'s zone', () => {
  it('patches the _mta-sts record in the right zone', async () => {
    const cf = world();
    const rec = cf.seed('zone-other', { type: 'TXT', name: '_mta-sts.other-company.org', content: 'v=STSv1; id=1' });
    await updateMtaStsTxtRecord(tenant(), 'other-company.org', rec.id, '2');
    expect(cf.records.get('zone-other')![0].content).toBe('v=STSv1; id=2');
    expect(cf.forZone('zone-acme')).toHaveLength(0);
  });

  it('patchCfDnsRecord targets the zone of the domain given', async () => {
    const cf = world();
    const rec = cf.seed('zone-other', { type: 'TXT', name: '_dmarc.other-company.org', content: 'v=DMARC1; p=none' });
    await patchCfDnsRecord(tenant(), 'other-company.org', rec.id, 'v=DMARC1; p=reject');
    expect(cf.records.get('zone-other')![0].content).toBe('v=DMARC1; p=reject');
  });

  it('deprovision deletes from the right zone and tolerates records that are already gone', async () => {
    const cf = world();
    const a = cf.seed('zone-other', { type: 'TXT', name: '_mta-sts.other-company.org', content: 'x' });
    await deprovisionMtaSts(tenant(), 'other-company.org', { mta_sts_record_id: a.id, tls_rpt_record_id: 'gone', cname_record_id: null });
    expect(cf.records.get('zone-other')).toEqual([]);
  });
});

describe('legacy records in the base zone (installs from before per-domain zones)', () => {
  // Old code created every domain's records in the base zone (zone-acme), even other-company.org's.
  it('patches a record that 404s in the domain\'s own zone in the base zone instead', async () => {
    const cf = world();
    const rec = cf.seed('zone-acme', { type: 'TXT', name: '_mta-sts.other-company.org', content: 'v=STSv1; id=1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await updateMtaStsTxtRecord(tenant(), 'other-company.org', rec.id, '2');
    expect(cf.records.get('zone-acme')![0].content).toBe('v=STSv1; id=2');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/legacy location/);
  });

  it('deletes a record that is only in the base zone, and logs it', async () => {
    const cf = world();
    const rec = cf.seed('zone-acme', { type: 'TXT', name: '_mta-sts.other-company.org', content: 'x' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deprovisionMtaSts(tenant(), 'other-company.org', { mta_sts_record_id: rec.id, tls_rpt_record_id: null, cname_record_id: null });
    expect(cf.records.get('zone-acme')).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/legacy location/);
  });

  it('prefers the domain\'s own zone, and does not touch the base zone when the record is there', async () => {
    const cf = world();
    const own = cf.seed('zone-other', { type: 'TXT', name: '_mta-sts.other-company.org', content: 'x' });
    await deprovisionMtaSts(tenant(), 'other-company.org', { mta_sts_record_id: own.id, tls_rpt_record_id: null, cname_record_id: null });
    expect(cf.records.get('zone-other')).toEqual([]);
    expect(cf.calls.filter(c => c.zoneId === 'zone-acme' && c.method === 'DELETE')).toHaveLength(0);
  });

  it('still fails when the record is in neither zone', async () => {
    world();
    await expect(updateMtaStsTxtRecord(tenant(), 'other-company.org', 'nowhere', '2')).rejects.toThrow(/CF DNS patch failed/);
  });
});
