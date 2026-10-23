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
  it('lists candidates longest first, never below two labels', () => {
    expect(zoneCandidates('acme.com')).toEqual(['acme.com']);
    expect(zoneCandidates('a.b.acme.com')).toEqual(['a.b.acme.com', 'b.acme.com', 'acme.com']);
    expect(zoneCandidates('Mail.Acme.CO.UK.')).toEqual(['mail.acme.co.uk', 'acme.co.uk', 'co.uk']);
  });
});

describe('CfClient.zoneFor', () => {
  it('finds the zone of a subdomain by its registrable name and returns the Cloudflare account', async () => {
    const fake = new FakeCloudflare({ 'acme.com': { id: 'z1', cfAccountId: 'acct-1' } });
    expect(await clientFor(fake).zoneFor('a.b.acme.com')).toEqual({ id: 'z1', name: 'acme.com', cfAccountId: 'acct-1' });
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
    expect((await cf.zoneFor('acme.com')).id).toBe('seeded');
    expect(fake.calls).toHaveLength(0);
    // a subdomain is checked for a zone of its own first (one lookup), then falls back to the seed
    expect((await cf.zoneFor('mail.acme.com')).id).toBe('seeded');
    expect(fake.calls).toHaveLength(1);
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

describe('CfClient.zoneFor with nested zones', () => {
  const nested = () => new FakeCloudflare({ 'example.com': { id: 'z-parent' }, 'sub.example.com': { id: 'z-child' } });

  it('the most specific zone wins over its parent', async () => {
    const cf = clientFor(nested());
    expect((await cf.zoneFor('_dmarc.sub.example.com')).id).toBe('z-child');
    expect((await cf.zoneFor('sub.example.com')).id).toBe('z-child');
    expect((await cf.zoneFor('other.example.com')).id).toBe('z-parent');
    expect((await cf.zoneFor('example.com')).id).toBe('z-parent');
  });

  it('a pre-loaded parent zone does not shadow a child zone', async () => {
    const fake = nested();
    const cf = clientFor(fake);
    cf.seedZone({ id: 'z-parent', name: 'example.com' });
    expect((await cf.zoneFor('_dmarc.sub.example.com')).id).toBe('z-child');
    // ...but still answers, without a lookup, for names with no longer candidate zone
    const before = fake.calls.length;
    expect((await cf.zoneFor('example.com')).id).toBe('z-parent');
    expect(fake.calls.length).toBe(before);
  });

  it('a pre-loaded parent answers for a subdomain that is not its own zone', async () => {
    const cf = clientFor(new FakeCloudflare({ 'example.com': { id: 'z-parent' } }));
    cf.seedZone({ id: 'z-parent', name: 'example.com' });
    expect((await cf.zoneFor('mail.example.com')).id).toBe('z-parent');
  });

  it('resolves a deep subdomain to the nearest enclosing zone', async () => {
    const fake = new FakeCloudflare({ 'example.com': { id: 'z-parent' }, 'b.example.com': { id: 'z-b' } });
    expect((await clientFor(fake).zoneFor('x.y.z.b.example.com')).id).toBe('z-b');
    expect((await clientFor(fake).zoneFor('x.y.z.other.example.com')).id).toBe('z-parent');
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
    await expect(clientFor(fake).deleteDnsRecord('z', 'missing')).resolves.toBe(false);
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

describe('TenantContext never leaks the env secrets', () => {
  it('is redacted in JSON, inspect and string output', async () => {
    const { makeTenant } = await import('../helpers/tenant');
    const t = makeTenant({ env: { CLOUDFLARE_API_TOKEN: TOKEN, API_KEY: 'api-key-secret' } as any, cfToken: TOKEN });
    const out = [JSON.stringify(t), inspect(t, { depth: 6 }), JSON.stringify({ wrapped: t }), `${inspect({ nested: [t] }, { depth: 6 })}`].join('\n');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('api-key-secret');
    expect(out).toContain('ws_default');
  });
});
