// Round two of "unknown is never not-found": an empty reports address matches nothing, and quoted CF content is normalised.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn(),
  deprovisionDomain: vi.fn(),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const get = (path: string) => new Request(`https://api.inboxangel.com${path}`, { method: 'GET' });

function makeEnv(rua: string, token?: string): Env {
  const db = createMigratedD1();
  db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address) VALUES (?, ?, ?)').run(1, 'acme.com', rua);
  seedSettings(db, { base_domain: 'acme.com', reports_domain: 'reports.test.com', from_email: 'noreply@reports.test.com', zone_id: 'zone-acme', zone_name: 'acme.com', cf_account_id: 'cf-acct' });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: token } as unknown as Env;
}

let cf: FakeCloudflare;
beforeEach(() => {
  cf = stubCloudflare(new FakeCloudflare({ 'acme.com': { id: 'zone-acme', cfAccountId: 'cf-acct' } }, undefined, undefined, { '_dmarc.acme.com': ['v=DMARC1; p=reject; rua=mailto:someone@else.test'] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('item 6: an empty reports address never matches', () => {
  it('dns-check: has_rua is false with an empty address (includes("") is always true)', async () => {
    const body = await (await handleApi(get('/api/domains/1/dns-check'), makeEnv(''), ctx)).json() as any;
    expect(body.found).toBe(true);
    expect(body.has_rua).toBe(false);
  });
  it('dns-check: whitespace-only address is also false', async () => {
    const body = await (await handleApi(get('/api/domains/1/dns-check'), makeEnv('  '), ctx)).json() as any;
    expect(body.has_rua).toBe(false);
  });
  it('dns-check: a real address still matches', async () => {
    cf.doh['_dmarc.acme.com'] = ['v=DMARC1; p=none; rua=mailto:rua@reports.test.com'];
    const body = await (await handleApi(get('/api/domains/1/dns-check'), makeEnv('rua@reports.test.com'), ctx)).json() as any;
    expect(body.has_rua).toBe(true);
  });
  it('onboarding-status: dmarc.has_our_rua is false with an empty address', async () => {
    const body = await (await handleApi(get('/api/domains/1/onboarding-status'), makeEnv(''), ctx)).json() as any;
    expect(body.dmarc.found).toBe(true);
    expect(body.dmarc.has_our_rua).toBe(false);
  });
});

describe('item 2 (server): Cloudflare-sourced DKIM content is unquoted', () => {
  it('onboarding-status returns selectors without the TXT quoting, split strings joined', async () => {
    cf.seed('zone-acme', { type: 'TXT', name: 'a._domainkey.acme.com', content: '"v=DKIM1; k=rsa; p="' });
    cf.seed('zone-acme', { type: 'TXT', name: 'b._domainkey.acme.com', content: '"v=DKIM1; k=rsa; " "p="' });
    cf.seed('zone-acme', { type: 'CNAME', name: 'c._domainkey.acme.com', content: 'c.dkim.provider.test' });
    const body = await (await handleApi(get('/api/domains/1/onboarding-status'), makeEnv('r@reports.test.com', 'tok'), ctx)).json() as any;
    expect(body.dkim.source).toBe('cf');
    const byName = Object.fromEntries(body.dkim.selectors.map((s: any) => [s.name, s.record]));
    expect(byName['a._domainkey.acme.com']).toBe('v=DKIM1; k=rsa; p=');
    expect(byName['b._domainkey.acme.com']).toBe('v=DKIM1; k=rsa; p=');
    expect(byName['c._domainkey.acme.com']).toBe('c.dkim.provider.test');
  });
});

describe('review item 8: report addresses compare case-insensitively', () => {
  it('dns-check and onboarding-status see our address in another letter case', async () => {
    cf.doh['_dmarc.acme.com'] = ['v=DMARC1; p=none; rua=mailto:RUA@Reports.Test.com'];
    const dns = await (await handleApi(get('/api/domains/1/dns-check'), makeEnv('rua@reports.test.com'), ctx)).json() as any;
    expect(dns.has_rua).toBe(true);
    const onboarding = await (await handleApi(get('/api/domains/1/onboarding-status'), makeEnv('rua@reports.test.com'), ctx)).json() as any;
    expect(onboarding.dmarc.has_our_rua).toBe(true);
  });
});
