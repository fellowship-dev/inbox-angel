import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));

import { flattenSpf, restoreSpf, findSpfRecord } from '../../src/email/spf-flattener';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { makeTenant } from '../helpers/tenant';

afterEach(() => vi.unstubAllGlobals());

function world() {
  const cf = stubCloudflare(new FakeCloudflare({
    'acme.com': { id: 'zone-acme', accountId: 'cf' },
    'other-company.org': { id: 'zone-other', accountId: 'cf' },
  }));
  cf.seed('zone-acme', { id: 'spf-acme', type: 'TXT', name: 'acme.com', content: 'v=spf1 include:_spf.mail.test -all' });
  cf.seed('zone-other', { id: 'spf-other', type: 'TXT', name: 'other-company.org', content: 'v=spf1 include:_spf.mail.test -all' });
  cf.doh['_spf.mail.test'] = ['v=spf1 ip4:192.0.2.7 -all'];
  cf.doh['acme.com'] = ['v=spf1 include:_spf.mail.test -all'];
  cf.doh['other-company.org'] = ['v=spf1 include:_spf.mail.test -all'];
  return cf;
}
const tenant = () => makeTenant({ cfToken: 'tok', settings: { zoneId: 'zone-acme', zoneName: 'acme.com' } });

describe('SPF flattening uses the zone of the domain being flattened', () => {
  it('flattens a domain from a second zone without touching the default zone', async () => {
    const cf = world();
    const result = await flattenSpf(tenant(), 'other-company.org');
    expect(result.cf_record_id).toBe('spf-other');
    expect(cf.records.get('zone-other')![0].content).toBe('v=spf1 ip4:192.0.2.7 -all');
    expect(cf.records.get('zone-acme')![0].content).toBe('v=spf1 include:_spf.mail.test -all');
    expect(cf.calls.filter(c => c.method === 'PATCH').every(c => c.zoneId === 'zone-other')).toBe(true);
  });

  it('flattens each of two domains in its own zone', async () => {
    const cf = world();
    const t = tenant();
    await flattenSpf(t, 'acme.com');
    await flattenSpf(t, 'other-company.org');
    expect(cf.records.get('zone-acme')![0].content).toBe('v=spf1 ip4:192.0.2.7 -all');
    expect(cf.records.get('zone-other')![0].content).toBe('v=spf1 ip4:192.0.2.7 -all');
  });

  it('restores the canonical record in the right zone', async () => {
    const cf = world();
    await restoreSpf(tenant(), 'other-company.org', 'spf-other', 'v=spf1 include:old.test -all');
    expect(cf.records.get('zone-other')![0].content).toBe('v=spf1 include:old.test -all');
  });

  it('reports a missing SPF record, and surfaces Cloudflare auth errors instead of "not found"', async () => {
    const cf = world();
    cf.records.set('zone-other', []);
    await expect(flattenSpf(tenant(), 'other-company.org')).rejects.toThrow(/No SPF TXT record found/);
    cf.failZone = { zoneId: 'zone-acme', status: 403, message: 'Authentication error' };
    await expect(findSpfRecord(tenant(), 'acme.com')).rejects.toThrow(/Authentication error/);
  });
});
