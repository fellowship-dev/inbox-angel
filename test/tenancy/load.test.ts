import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { loadTenant, refreshTenant } from '../../src/tenancy/load';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ACCT = { workspaceId: 'ws_default' };
const stored = (db: any, key: string) => (db.sqlite.prepare("SELECT value FROM settings WHERE workspace_id = 'ws_default' AND key = ?").get(key) as any)?.value;

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('loadTenant', () => {
  it('reads the tenant\'s settings and derives the reports domain and from-address', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'acme.com', brand_color: '#123456', brand_logo_url: 'https://x/logo.png' });
    const t = await loadTenant({ DB: db } as any, ACCT);
    expect(t.settings).toMatchObject({
      baseDomain: 'acme.com', reportsDomain: 'reports.acme.com', fromEmail: 'noreply@reports.acme.com',
      brandColor: '#123456', brandLogoUrl: 'https://x/logo.png',
    });
    expect(t.cf()).toBeNull(); // no token, no Cloudflare client
  });

  it('resolves the base domain\'s zone once, persists it, and later loads make no Cloudflare call', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'acme.com' });
    const cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-1', cfAccountId: 'cf-acct' } }));
    const env = { DB: db, CLOUDFLARE_API_TOKEN: 'tok' } as any;

    const first = await loadTenant(env, ACCT);
    expect(first.settings).toMatchObject({ zoneId: 'zone-1', zoneName: 'acme.com', cfAccountId: 'cf-acct' });
    expect(stored(db, 'zone_id')).toBe('zone-1');
    expect(stored(db, 'zone_name')).toBe('acme.com');
    expect(stored(db, 'cf_account_id')).toBe('cf-acct');
    expect(cf.calls).toHaveLength(1);

    const second = await loadTenant(env, ACCT);
    expect(second.settings.zoneId).toBe('zone-1');
    expect(cf.calls).toHaveLength(1);
    // the stored zone is what zoneFor() uses for the base domain itself, with no lookup
    expect((await second.zoneFor('acme.com')).id).toBe('zone-1');
    expect(cf.calls).toHaveLength(1);
    // a subdomain checks for a zone of its own first, then falls back to the stored one
    expect((await second.zoneFor('www.acme.com')).id).toBe('zone-1');
    expect(cf.calls).toHaveLength(2);
  });

  it('resolves a subdomain base domain to the apex zone', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'marketing.acme.com' });
    stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-apex', cfAccountId: 'cf' } }));
    const t = await loadTenant({ DB: db, CLOUDFLARE_API_TOKEN: 'tok' } as any, ACCT);
    expect(t.settings).toMatchObject({ zoneId: 'zone-apex', zoneName: 'acme.com' });
  });

  it('learns the zone name of installs that only stored a zone id', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'acme.com', zone_id: 'zone-old', cf_account_id: 'cf' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { id: 'zone-old', name: 'Acme.com' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = await loadTenant({ DB: db, CLOUDFLARE_API_TOKEN: 'tok' } as any, ACCT);
    expect(t.settings.zoneName).toBe('acme.com');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/zones/zone-old');
    expect(stored(db, 'zone_name')).toBe('acme.com');
  });

  it('survives a Cloudflare failure (token without Zone:Read) and logs no token', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'acme.com' });
    stubCloudflare(new FakeCloudflare({}, { status: 403, message: 'Authentication error' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await loadTenant({ DB: db, CLOUDFLARE_API_TOKEN: 'tok-secret' } as any, ACCT);
    expect(t.settings.zoneId).toBeUndefined();
    expect(t.settings.reportsDomain).toBe('reports.acme.com');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('tok-secret');
  });

  it('refreshTenant picks up settings changed since the tenant was built', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'old.com' });
    const t = await loadTenant({ DB: db } as any, ACCT);
    await t.scope.settings.setMany({ base_domain: 'new.com', reports_domain: 'reports.new.com' });
    await refreshTenant(t);
    expect(t.settings.baseDomain).toBe('new.com');
    expect(t.settings.reportsDomain).toBe('reports.new.com');
  });

  it('workersSubdomain() looks it up lazily, stores it, and does so once', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'acme.com', zone_id: 'z', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { subdomain: 'fellowshipdev' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = await loadTenant({ DB: db, CLOUDFLARE_API_TOKEN: 'tok' } as any, ACCT);
    expect(fetchMock).not.toHaveBeenCalled(); // not on the hot path
    expect(await t.workersSubdomain()).toBe('fellowshipdev');
    expect(await t.workersSubdomain()).toBe('fellowshipdev');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored(db, 'workers_subdomain')).toBe('fellowshipdev');
  });
});

describe('the wizard\'s base-domain change', () => {
  it('forgets the previous domain\'s zone instead of keeping writing to it', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'old.com', zone_id: 'zone-old', zone_name: 'old.com', cf_account_id: 'cf' });
    const cf = stubCloudflare(new FakeCloudflare({ 'new.com': { id: 'zone-new', cfAccountId: 'cf' } }));
    const env = { DB: db, CLOUDFLARE_API_TOKEN: 'tok' } as any;
    const t = await loadTenant(env, ACCT);
    expect(t.settings.zoneId).toBe('zone-old');

    await t.scope.settings.setMany({ base_domain: 'new.com', reports_domain: 'reports.new.com', zone_id: '', zone_name: '', cf_account_id: '' });
    await refreshTenant(t);
    expect(t.settings).toMatchObject({ baseDomain: 'new.com', zoneId: 'zone-new', zoneName: 'new.com' });
    expect(cf.calls.some(c => c.url.includes('name=new.com'))).toBe(true);
  });
});
