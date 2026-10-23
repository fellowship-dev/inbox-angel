import { describe, it, expect, vi } from 'vitest';
import { CfClient, CfRecordNotAllowedError, CfZoneNotAllowedError } from '../../src/tenancy/cf-client';
import { policyFor } from '../../src/connections/service';
import type { Mode } from '../../src/tenancy/mode';

const ZONE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const REC = 'c'.repeat(32);
const zones = [{ zone_id: ZONE, zone_name: 'acme.com', cf_account_id: 'acct1' }] as any;

function client(mode: Mode) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { id: REC } }), { status: 200 }));
  const cf = new CfClient('tok', { fetch: fetch as unknown as typeof globalThis.fetch, mode, policy: policyFor('conn1', zones, [], 'acct1', mode) });
  return { cf, fetch };
}
const txt = (name: string, content = 'v=DMARC1; p=none') => ({ type: 'TXT', name, content, ttl: 3600 });

describe('a connection-backed client (saas) sends only managed DNS writes', () => {
  const refused: [string, (cf: CfClient) => Promise<unknown>, unknown][] = [
    ['A record', cf => cf.createDnsRecord(ZONE, { type: 'A', name: 'acme.com', content: '1.2.3.4' }), CfRecordNotAllowedError],
    ['MX record', cf => cf.createDnsRecord(ZONE, { type: 'MX', name: 'acme.com', content: 'route1.mx.cloudflare.net', priority: 1 }), CfRecordNotAllowedError],
    ['TXT at a random name', cf => cf.createDnsRecord(ZONE, txt('www.acme.com', 'hi')), CfRecordNotAllowedError],
    ['name outside the zone', cf => cf.createDnsRecord(ZONE, txt('_dmarc.evil.com')), CfRecordNotAllowedError],
    ['other zone id', cf => cf.createDnsRecord(OTHER, txt('_dmarc.acme.com')), CfZoneNotAllowedError],
    ['PATCH renaming to an unmanaged name', cf => cf.patchDnsRecord(ZONE, REC, { type: 'TXT', name: 'www.acme.com', content: 'x' }), CfRecordNotAllowedError],
    ['DELETE of a malformed id', cf => cf.deleteDnsRecord(ZONE, 'not-hex'), CfRecordNotAllowedError],
    ['DELETE in another zone', cf => cf.deleteDnsRecord(OTHER, REC), CfZoneNotAllowedError],
    ['path tricks', cf => cf.request('DELETE', `/zones/${ZONE}/dns_records/../settings/x`), Error],
    ['dns_records sub-path (batch)', cf => cf.request('POST', `/zones/${ZONE}/dns_records/batch`, { body: {} }), CfRecordNotAllowedError],
    ['zone settings write', cf => cf.request('PATCH', `/zones/${ZONE}/settings/ssl`, { body: { value: 'off' } }), CfRecordNotAllowedError],
    ['rulesets write', cf => cf.request('POST', `/zones/${ZONE}/rulesets`, { body: {} }), CfRecordNotAllowedError],
    ['workers routes write', cf => cf.request('POST', `/zones/${ZONE}/workers/routes`, { body: {} }), CfRecordNotAllowedError],
    ['email routing write', cf => cf.request('PUT', `/zones/${ZONE}/email/routing/rules/catch_all`, { body: {} }), CfRecordNotAllowedError],
    ['/accounts write', cf => cf.request('PUT', '/accounts/acct1/workers/domains', { body: {} }), CfRecordNotAllowedError],
    ['DKIM CNAME to an attacker host', cf => cf.createDnsRecord(ZONE, { type: 'CNAME', name: 's1._domainkey.acme.com', content: 'evil.example' }), CfRecordNotAllowedError],
    ['BIMI TXT', cf => cf.createDnsRecord(ZONE, txt('default._bimi.acme.com')), CfRecordNotAllowedError],
    ['mta-sts CNAME to an attacker host', cf => cf.createDnsRecord(ZONE, { type: 'CNAME', name: 'mta-sts.acme.com', content: 'attacker.example' }, { cnameTargets: ['w.workers.dev'] }), CfRecordNotAllowedError],
    ['SPF at _x.D', cf => cf.createDnsRecord(ZONE, { type: 'TXT', name: '_x.acme.com', content: 'v=spf1 -all' }), CfRecordNotAllowedError],
    ['SPF at a name outside allowedApexes', cf => cf.createDnsRecord(ZONE, { type: 'TXT', name: 'random.acme.com', content: 'v=spf1 -all' }, { allowedApexes: ['acme.com'] }), CfRecordNotAllowedError],
    ['/user write', cf => cf.request('POST', '/user/tokens', { body: {} }), CfRecordNotAllowedError],
    ['read of zone settings', cf => cf.request('GET', `/zones/${ZONE}/settings`), CfRecordNotAllowedError],
    ['read of arbitrary path', cf => cf.request('GET', '/memberships'), CfRecordNotAllowedError],
  ];
  it.each(refused)('refuses %s without calling fetch', async (_t, run, errType) => {
    const { cf, fetch } = client('saas');
    await expect(run(cf)).rejects.toBeInstanceOf(errType as typeof Error);
    expect(fetch).not.toHaveBeenCalled();
  });

  const allowed: [string, (cf: CfClient) => Promise<unknown>][] = [
    ['DMARC TXT create', cf => cf.createDnsRecord(ZONE, txt('_dmarc.acme.com'))],
    ['SPF update', cf => cf.patchDnsRecord(ZONE, REC, { content: 'v=spf1 -all' })],
    ['mta-sts CNAME to the vouched host', cf => cf.createDnsRecord(ZONE, { type: 'CNAME', name: 'mta-sts.acme.com', content: 'w.workers.dev' }, { cnameTargets: ['w.workers.dev'] })],
    ['record delete', cf => cf.deleteDnsRecord(ZONE, REC)],
    ['record list', cf => cf.listDnsRecords(ZONE, { type: 'TXT' })],
    ['workers routes read', cf => cf.request('GET', `/zones/${ZONE}/workers/routes`)],
    ['zone read', cf => cf.getZone(ZONE)],
    ['token verify', cf => cf.verifyToken()],
    ['zone name lookup in scope', cf => cf.request('GET', '/zones', { query: { name: 'acme.com' } })],
  ];
  it.each(allowed)('allows %s (fetch called once)', async (_t, run) => {
    const { cf, fetch } = client('saas');
    await run(cf);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('MX is refused in saas even for the Email Routing hosts, but allowed in self-host', async () => {
    const mx = { type: 'MX', name: 'reports.acme.com', content: 'route1.mx.cloudflare.net', priority: 40 };
    const s = client('saas');
    await expect(s.cf.createDnsRecord(ZONE, mx)).rejects.toBeInstanceOf(CfRecordNotAllowedError);
    expect(s.fetch).not.toHaveBeenCalled();
    const h = client('selfhost');
    await h.cf.createDnsRecord(ZONE, mx);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('self-host connection clients keep the setup wizard calls (email routing, workers domains)', async () => {
    const { cf, fetch } = client('selfhost');
    await cf.request('PUT', `/zones/${ZONE}/email/routing/enable`);
    await cf.request('PUT', '/accounts/acct1/workers/domains', { body: {} });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('an env-token client (no allow-list)', () => {
  it('still applies the record type/name check, and learns zone names from seedZone', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }));
    const cf = new CfClient('tok', { fetch: fetch as unknown as typeof globalThis.fetch, mode: 'selfhost' });
    cf.seedZone({ id: 'z1', name: 'acme.com' });
    await expect(cf.createDnsRecord('z1', { type: 'A', name: 'acme.com', content: '1.1.1.1' })).rejects.toBeInstanceOf(CfRecordNotAllowedError);
    await expect(cf.createDnsRecord('z1', txt('_dmarc.other.org'))).rejects.toBeInstanceOf(CfRecordNotAllowedError);
    expect(fetch).not.toHaveBeenCalled();
    await cf.createDnsRecord('z1', txt('_dmarc.acme.com'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
