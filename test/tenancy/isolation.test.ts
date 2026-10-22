import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', accountId: 'acct_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: 'x', manual: true }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import type { Env } from '../../src/index';
import { handleApi } from '../../src/api/router';
import { loadTenant } from '../../src/tenancy/load';
import type { AccountResolver } from '../../src/tenancy/resolver';
import { buildDnsAlertHtml } from '../../src/email/html-templates';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { makeTenant, seedSettings } from '../helpers/tenant';
import { lastDays, seedDomainReports } from '../analytics/world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => vi.unstubAllGlobals());

/** One D1, two accounts with different domains, zones, reports domains and branding. */
function twoAccountEnv() {
  const db = createMigratedD1();
  for (const id of ['acct_a', 'acct_b']) db.sqlite.prepare('INSERT INTO accounts (id, name) VALUES (?, ?)').run(id, id);

  seedSettings(db, {
    base_domain: 'a-corp.com', reports_domain: 'reports.a-corp.com', from_email: 'noreply@reports.a-corp.com',
    zone_id: 'zone-a', zone_name: 'a-corp.com', account_id: 'cf-a', brand_color: '#ff0000', telemetry_opted_in: 'true',
  }, 'acct_a');
  seedSettings(db, {
    base_domain: 'b-corp.org', reports_domain: 'reports.b-corp.org', from_email: 'noreply@reports.b-corp.org',
    zone_id: 'zone-b', zone_name: 'b-corp.org', account_id: 'cf-b', brand_color: '#00ff00',
  }, 'acct_b');

  const insertDomain = db.sqlite.prepare('INSERT INTO domains (id, account_id, domain, rua_address) VALUES (?, ?, ?, ?)');
  insertDomain.run(1, 'acct_a', 'a-corp.com', 'rua@reports.a-corp.com');
  insertDomain.run(2, 'acct_b', 'b-corp.org', 'rua@reports.b-corp.org');

  const env = { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'tok' } as Env;
  return { db, env };
}

const as = (accountId: string): AccountResolver => async () => ({ accountId, role: 'owner' });

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://x.test${path}`, {
    method,
    headers: { 'x-api-key': 'k', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('two concurrent requests for different accounts in one isolate', () => {
  it('each sees only its own settings, domains and zone', async () => {
    const { env } = twoAccountEnv();
    const cf = new FakeCloudflare({
      'a-corp.com': { id: 'zone-a', accountId: 'cf-a' },
      'b-corp.org': { id: 'zone-b', accountId: 'cf-b' },
    });
    // Random latency per Cloudflare call so the two requests really interleave.
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { await sleep(Math.random() * 15); return cf.fetch(...a); });

    const run = async (acct: string) => {
      const send = (r: Request) => handleApi(r, env, ctx, as(acct));
      const session = await (await send(request('POST', '/api/check-sessions'))).json() as any;
      const status = await (await send(request('GET', '/api/auth/status'))).json() as any;
      const domains = await (await send(request('GET', '/api/domains'))).json() as any;
      return { session, status, domains };
    };

    // Repeat to shake out ordering luck.
    for (let i = 0; i < 5; i++) {
      const [a, b] = await Promise.all([run('acct_a'), run('acct_b')]);

      expect(a.session.email.endsWith('@reports.a-corp.com')).toBe(true);
      expect(b.session.email.endsWith('@reports.b-corp.org')).toBe(true);
      expect(a.status.base_domain).toBe('a-corp.com');
      expect(b.status.base_domain).toBe('b-corp.org');
      expect(a.domains.domains.map((d: any) => d.domain)).toEqual(['a-corp.com']);
      expect(b.domains.domains.map((d: any) => d.domain)).toEqual(['b-corp.org']);
    }

    // Writes land in the zone of the requesting account's domain, and one account cannot reach the other's domain.
    const writes = await Promise.all([
      handleApi(request('POST', '/api/domains/1/apply-dmarc', { record: 'v=DMARC1; p=none' }), env, ctx, as('acct_a')),
      handleApi(request('POST', '/api/domains/2/apply-dmarc', { record: 'v=DMARC1; p=reject' }), env, ctx, as('acct_b')),
      handleApi(request('POST', '/api/domains/2/apply-dmarc', { record: 'v=DMARC1; p=none' }), env, ctx, as('acct_a')),
    ]);
    expect(writes.map(r => r.status)).toEqual([200, 200, 404]);
    expect(cf.records.get('zone-a')).toEqual([expect.objectContaining({ name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=none' })]);
    expect(cf.records.get('zone-b')).toEqual([expect.objectContaining({ name: '_dmarc.b-corp.org', content: 'v=DMARC1; p=reject' })]);
  });

  it('keeps branding, from-address and telemetry opt-in per account', async () => {
    const { env } = twoAccountEnv();
    const [a, b] = await Promise.all([
      loadTenant(env as any, { accountId: 'acct_a' }),
      loadTenant(env as any, { accountId: 'acct_b' }),
    ]);

    expect(a.brand.color).toBe('#ff0000');
    expect(b.brand.color).toBe('#00ff00');
    expect(a.settings.fromEmail).toBe('noreply@reports.a-corp.com');
    expect(b.settings.fromEmail).toBe('noreply@reports.b-corp.org');

    const params = { domain: 'x.com', changes: [], reportsDomain: 'reports.x.com' };
    const htmlA = buildDnsAlertHtml({ ...params, brand: a.brand });
    const htmlB = buildDnsAlertHtml({ ...params, brand: b.brand });
    expect(htmlA).toContain('#ff0000');
    expect(htmlA).not.toContain('#00ff00');
    expect(htmlB).toContain('#00ff00');
    expect(htmlB).not.toContain('#ff0000');

    expect(await a.telemetryEnabled()).toBe(true);
    expect(await b.telemetryEnabled()).toBe(false);
  });

  it('resolves the same domain name to different zones for different tenants', async () => {
    const cfA = new FakeCloudflare({ 'shared.com': { id: 'zone-shared-a' } });
    const cfB = new FakeCloudflare({ 'shared.com': { id: 'zone-shared-b' } });
    const delayed = (fake: FakeCloudflare) => (async (...a: Parameters<typeof fetch>) => { await sleep(Math.random() * 10); return fake.fetch(...a); }) as typeof fetch;
    const a = makeTenant({ accountId: 'acct_a', cfToken: 'tok-a', fetch: delayed(cfA) });
    const b = makeTenant({ accountId: 'acct_b', cfToken: 'tok-b', fetch: delayed(cfB) });

    const [za, zb] = await Promise.all([a.zoneFor('shared.com'), b.zoneFor('www.shared.com')]);
    expect(za.id).toBe('zone-shared-a');
    expect(zb.id).toBe('zone-shared-b');
    expect(cfA.calls[0].auth).toBe('Bearer tok-a');
    expect(cfB.calls[0].auth).toBe('Bearer tok-b');
  });
});

// The read-only analytics endpoints (src/analytics/routes.ts): each account's sender inventory, trend, fixes and
// readiness come only from its own domains, whichever domain id or window the caller asks for.
describe('analytics endpoints under concurrent tenants', () => {
  const OWN: Record<string, { ip: string; domain: string; id: number }> = {
    acct_a: { ip: '198.51.100.10', domain: 'a-corp.com', id: 1 },
    acct_b: { ip: '203.0.113.20', domain: 'b-corp.org', id: 2 },
  };

  async function seeded() {
    const { db, env } = twoAccountEnv();
    for (const [acct, o] of Object.entries(OWN)) {
      await seedDomainReports(db, acct, o.id, o.domain, lastDays(10), [
        { ip: o.ip, count: 50, pass: false, spf: ['pass', 'mcsv.net'], dkim: ['pass', 'mcsv.net'], reverse_dns: 'mail1.mcsv.net', base_domain: 'mcsv.net' },
        { ip: '192.0.2.1', count: 50, pass: true },
      ]);
    }
    return { db, env };
  }

  it('account-wide and per-domain answers never include another account', async () => {
    const { env } = await seeded();
    vi.stubGlobal('fetch', async () => { await sleep(Math.random() * 10); return new Response(JSON.stringify({ Status: 3 })); });
    const ask = async (acct: string, path: string) => (await handleApi(request('GET', path), env, ctx, as(acct))).json() as Promise<any>;

    for (let i = 0; i < 4; i++) {
      const [wa, wb, da, db_] = await Promise.all([
        ask('acct_a', '/api/analytics?days=30'), ask('acct_b', '/api/analytics?days=30'),
        ask('acct_a', '/api/domains/1/analytics'), ask('acct_b', '/api/domains/2/analytics'),
      ]);
      for (const [acct, wide, one] of [['acct_a', wa, da], ['acct_b', wb, db_]] as const) {
        const mine = OWN[acct]!;
        const other = OWN[acct === 'acct_a' ? 'acct_b' : 'acct_a']!;
        for (const body of [wide, one]) {
          const text = JSON.stringify(body);
          expect(text).toContain(mine.ip);
          expect(text).not.toContain(other.ip);
          expect(text).not.toContain(other.domain);
        }
        expect(wide.domains.map((d: any) => d.domain)).toEqual([mine.domain]);
        expect(wide.totals.messages).toBe(10 * 100);
        expect(one.totals.messages).toBe(10 * 100);
        expect(wide.fixes.every((f: any) => f.domain === mine.domain)).toBe(true);
      }
    }
  });

  it('a domain id from another account is a 404, in both directions', async () => {
    const { env } = await seeded();
    const status = async (acct: string, path: string) => (await handleApi(request('GET', path), env, ctx, as(acct))).status;
    expect(await status('acct_a', '/api/domains/2/analytics')).toBe(404);
    expect(await status('acct_b', '/api/domains/1/analytics')).toBe(404);
    expect(await status('acct_a', '/api/domains/1/analytics')).toBe(200);
  });
});
