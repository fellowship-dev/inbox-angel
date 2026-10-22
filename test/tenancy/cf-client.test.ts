import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import {
  CfApiError, CfAuthError, CfClient, CfNetworkError, CfNotConfiguredError, CfNotFoundError, CfZoneNotFoundError,
  cfErrorText, zoneCandidates,
} from '../../src/tenancy/cf-client';
import { FakeCloudflare } from '../helpers/cf-fake';

const TOKEN = 'super-secret-token-value';
afterEach(() => vi.restoreAllMocks());

function clientFor(fake: FakeCloudflare) {
  return new CfClient(TOKEN, { fetch: fake.fetch as unknown as typeof fetch });
}

describe('zoneCandidates', () => {
  it('lists registrable candidates shortest first, never below two labels', () => {
    expect(zoneCandidates('acme.com')).toEqual(['acme.com']);
    expect(zoneCandidates('a.b.acme.com')).toEqual(['acme.com', 'b.acme.com', 'a.b.acme.com']);
    expect(zoneCandidates('Mail.Acme.CO.UK.')).toEqual(['co.uk', 'acme.co.uk', 'mail.acme.co.uk']);
  });
});

describe('CfClient.zoneFor', () => {
  it('finds the zone of a subdomain by its registrable name and returns the Cloudflare account', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1', accountId: 'acct-1' } });
    expect(await clientFor(fake).zoneFor('a.b.acme.com')).toEqual({ id: 'z1', name: 'acme.com', accountId: 'acct-1' });
  });

  it('skips names Cloudflare has no zone for (co.uk) and finds the real one', async () => {
    const fake = new FakeCloudflare({ 'acme.co.uk': { id: 'z-uk' } });
    expect((await clientFor(fake).zoneFor('www.acme.co.uk')).id).toBe('z-uk');
  });

  it('caches per client: repeated and concurrent lookups hit the API once', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    const cf = clientFor(fake);
    await Promise.all([cf.zoneFor('acme.com'), cf.zoneFor('acme.com'), cf.zoneFor('www.acme.com')]);
    await cf.zoneFor('acme.com');
    expect(fake.calls.filter(c => c.url.includes('name=acme.com'))).toHaveLength(1);
  });

  it('does not share the cache between clients (no module-level state)', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    await clientFor(fake).zoneFor('acme.com');
    await clientFor(fake).zoneFor('acme.com');
    expect(fake.calls.filter(c => c.url.includes('name=acme.com'))).toHaveLength(2);
  });

  it('uses a seeded zone without any API call', async () => {
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    cf.seedZone({ id: 'seeded', name: 'acme.com' });
    expect((await cf.zoneFor('mail.acme.com')).id).toBe('seeded');
    expect(fake.calls).toHaveLength(0);
  });

  it('throws CfZoneNotFoundError when no candidate exists, and retries after a failed lookup', async () => {
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    await expect(cf.zoneFor('nope.net')).rejects.toBeInstanceOf(CfZoneNotFoundError);

    fake.failWith = { status: 500, message: 'boom' };
    await expect(cf.zoneFor('flaky.net')).rejects.toBeInstanceOf(CfApiError);
    fake.failWith = undefined;
    fake.zones['flaky.net'] = { id: 'z-flaky' };
    expect((await cf.zoneFor('flaky.net')).id).toBe('z-flaky');
  });
});

describe('CfClient typed errors', () => {
  it('maps 401/403 to CfAuthError, 404 to CfNotFoundError, other failures to CfApiError', async () => {
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    fake.failWith = { status: 403, message: 'no permission' };
    await expect(cf.request('GET', '/zones')).rejects.toBeInstanceOf(CfAuthError);
    fake.failWith = { status: 401, message: 'bad token' };
    await expect(cf.request('GET', '/zones')).rejects.toBeInstanceOf(CfAuthError);
    fake.failWith = { status: 404, message: 'gone' };
    await expect(cf.request('GET', '/zones')).rejects.toBeInstanceOf(CfNotFoundError);
    fake.failWith = { status: 400, message: 'bad request' };
    const e = await cf.request('GET', '/zones').catch(x => x);
    expect(e).toBeInstanceOf(CfApiError);
    expect(e.status).toBe(400);
    expect(e.details).toEqual([{ message: 'bad request' }]);
    expect(cfErrorText(e)).toBe('bad request');
  });

  it('treats success:false on HTTP 200 as an error', async () => {
    const cf = new CfClient(TOKEN, { fetch: (async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 200 })) as typeof fetch });
    await expect(cf.request('GET', '/x')).rejects.toBeInstanceOf(CfApiError);
  });

  it('maps a thrown fetch to CfNetworkError without echoing the cause', async () => {
    const cf = new CfClient(TOKEN, { fetch: (async () => { throw new Error(`socket hang up for ${TOKEN}`); }) as typeof fetch });
    const e = await cf.request('GET', '/zones').catch(x => x);
    expect(e).toBeInstanceOf(CfNetworkError);
    expect(String(e.message)).not.toContain(TOKEN);
  });

  it('delete of a missing record is not an error', async () => {
    const fake = new FakeCloudflare({});
    await expect(clientFor(fake).deleteDnsRecord('z', 'missing')).resolves.toBeUndefined();
  });

  it('refuses to be built without a token', () => {
    expect(() => new CfClient('')).toThrow(CfNotConfiguredError);
  });
});

describe('CfClient never leaks the token', () => {
  it('sends it only as the Authorization header', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1' } });
    await clientFor(fake).zoneFor('acme.com');
    expect(fake.calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(fake.calls[0].url).not.toContain(TOKEN);
  });

  it('is absent from errors, JSON, inspect output and console logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map(s => s.mockImplementation(() => {}));
    const fake = new FakeCloudflare({});
    const cf = clientFor(fake);
    fake.failWith = { status: 403, message: 'Authentication error' };
    const e = await cf.zoneFor('acme.com').catch(x => x);

    const everything = [
      JSON.stringify(cf), inspect(cf, { depth: 5 }), String(cf), `${cf}`,
      e.message, e.stack, inspect(e, { depth: 5 }), JSON.stringify({ ...e, message: e.message }),
      ...logs.flatMap(l => l.mock.calls.map(c => c.map(String).join(' '))),
    ].join('\n');
    expect(everything).not.toContain(TOKEN);
  });
});
