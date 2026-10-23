import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureEmailRouting, registerEmailRoutingDestination } from '../../src/setup/email-routing';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { makeTenant } from '../helpers/tenant';

afterEach(() => vi.unstubAllGlobals());

/** The fake doesn't model Email Routing; answer those endpoints and record the rest as usual. */
function routingWorld(zones: Record<string, { id: string; cfAccountId?: string }>) {
  const cf = new FakeCloudflare(zones);
  const base = cf.fetch.getMockImplementation()!;
  const rules: Record<string, unknown> = {};
  cf.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = url.pathname.match(/\/zones\/([^/]+)\/email\/routing\/(.*)$/);
    if (m) {
      cf.calls.push({ method, url: url.toString(), zoneId: m[1], body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (m[2] === 'rules/catch_all' && method === 'PUT') { rules[m[1]] = JSON.parse(init!.body as string); return new Response(JSON.stringify({ success: true, result: {} })); }
      if (m[2] === 'rules/catch_all') return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), { status: 404 });
      return new Response(JSON.stringify({ success: true, result: {} }));
    }
    return base(input, init);
  });
  stubCloudflare(cf);
  return { cf, rules };
}

describe('ensureEmailRouting', () => {
  it('configures the reports domain\'s own zone with the Worker as catch-all target', async () => {
    const { cf, rules } = routingWorld({ 'reports-zone.io': { id: 'zone-reports' }, 'acme.com': { id: 'zone-acme' } });
    const t = makeTenant({ cfToken: 'tok', env: { WORKER_NAME: 'my-angel' } as any, settings: { reportsDomain: 'reports.reports-zone.io', zoneId: 'zone-acme', zoneName: 'acme.com' } });

    const result = await ensureEmailRouting(t);

    expect(result.status).toBe('newly_configured');
    expect(rules['zone-reports']).toMatchObject({ actions: [{ type: 'worker', value: ['my-angel'] }] });
    expect(cf.forZone('zone-acme')).toHaveLength(0); // the default zone is not touched
    const mx = cf.records.get('zone-reports')!.filter(r => r.type === 'MX');
    expect(mx).toHaveLength(3);
  });

  it('defaults the catch-all target to inbox-angel-worker', async () => {
    const { rules } = routingWorld({ 'acme.com': { id: 'zone-acme' } });
    await ensureEmailRouting(makeTenant({ cfToken: 'tok', settings: { reportsDomain: 'reports.acme.com', zoneId: 'zone-acme', zoneName: 'acme.com' } }));
    expect(rules['zone-acme']).toMatchObject({ actions: [{ type: 'worker', value: ['inbox-angel-worker'] }] });
  });

  it('is skipped without a token or without a zone for the reports domain', async () => {
    routingWorld({});
    expect((await ensureEmailRouting(makeTenant({ settings: { reportsDomain: 'reports.acme.com' } }))).status).toBe('skipped');
    expect((await ensureEmailRouting(makeTenant({ cfToken: 'tok', settings: { reportsDomain: 'reports.acme.com' } }))).status).toBe('skipped');
  });
});

describe('registerEmailRoutingDestination', () => {
  it('registers the address on the tenant\'s own Cloudflare account', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = makeTenant({ cfToken: 'tok', settings: { cfAccountId: 'cf-mine' } });
    expect(await registerEmailRoutingDestination(t, 'me@acme.com')).toBe(true);
    expect((fetchMock.mock.calls[0] as any)[0]).toBe('https://api.cloudflare.com/client/v4/accounts/cf-mine/email/routing/addresses');
  });

  it('treats "already exists" as success and a network failure as failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTenant({ cfToken: 'tok', settings: { cfAccountId: 'cf' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'Address already exists' }] }), { status: 400 })));
    expect(await registerEmailRoutingDestination(t, 'me@acme.com')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await registerEmailRoutingDestination(t, 'me@acme.com')).toBe(false);
  });

  it('does nothing without credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await registerEmailRoutingDestination(makeTenant({}), 'me@acme.com')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
