import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
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
import type { WorkspaceResolver } from '../../src/tenancy/resolver';
import { buildDnsAlertHtml } from '../../src/email/html-templates';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { makeTenant, seedSettings } from '../helpers/tenant';
import { lastDays, seedDomainReports } from '../analytics/world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => vi.unstubAllGlobals());

/** One D1, two workspaces with different domains, zones, reports domains and branding. */
function twoWorkspaceEnv() {
  const db = createMigratedD1();
  for (const id of ['ws_a', 'ws_b']) db.sqlite.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(id, id);

  seedSettings(db, {
    base_domain: 'a-corp.com', reports_domain: 'reports.a-corp.com', from_email: 'noreply@reports.a-corp.com',
    zone_id: 'zone-a', zone_name: 'a-corp.com', cf_account_id: 'cf-a', brand_color: '#ff0000', telemetry_opted_in: 'true',
  }, 'ws_a');
  seedSettings(db, {
    base_domain: 'b-corp.org', reports_domain: 'reports.b-corp.org', from_email: 'noreply@reports.b-corp.org',
    zone_id: 'zone-b', zone_name: 'b-corp.org', cf_account_id: 'cf-b', brand_color: '#00ff00',
  }, 'ws_b');

  const insertDomain = db.sqlite.prepare('INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, ?, ?, ?)');
  insertDomain.run(1, 'ws_a', 'a-corp.com', 'rua@reports.a-corp.com');
  insertDomain.run(2, 'ws_b', 'b-corp.org', 'rua@reports.b-corp.org');

  const env = { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'tok' } as Env;
  return { db, env };
}

const as = (workspaceId: string): WorkspaceResolver => async () => ({ workspaceId, role: 'owner' });

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://x.test${path}`, {
    method,
    headers: { 'x-api-key': 'k', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('two concurrent requests for different workspaces in one isolate', () => {
  it('each sees only its own settings, domains and zone', async () => {
    const { env } = twoWorkspaceEnv();
    const cf = new FakeCloudflare({
      'a-corp.com': { id: 'zone-a', cfAccountId: 'cf-a' },
      'b-corp.org': { id: 'zone-b', cfAccountId: 'cf-b' },
    });
    // Random latency per Cloudflare call so the two requests really interleave.
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { await sleep(Math.random() * 15); return cf.fetch(...a); });

    const run = async (ws: string) => {
      const send = (r: Request) => handleApi(r, env, ctx, as(ws));
      const session = await (await send(request('POST', '/api/check-sessions'))).json() as any;
      const status = await (await send(request('GET', '/api/auth/status'))).json() as any;
      const domains = await (await send(request('GET', '/api/domains'))).json() as any;
      return { session, status, domains };
    };

    // Repeat to shake out ordering luck.
    for (let i = 0; i < 5; i++) {
      const [a, b] = await Promise.all([run('ws_a'), run('ws_b')]);

      expect(a.session.email.endsWith('@reports.a-corp.com')).toBe(true);
      expect(b.session.email.endsWith('@reports.b-corp.org')).toBe(true);
      expect(a.status.base_domain).toBe('a-corp.com');
      expect(b.status.base_domain).toBe('b-corp.org');
      expect(a.domains.domains.map((d: any) => d.domain)).toEqual(['a-corp.com']);
      expect(b.domains.domains.map((d: any) => d.domain)).toEqual(['b-corp.org']);
    }

    // Self-host: the server's token belongs to the instance's own workspace (ws_default) alone. Neither of these
    // workspaces may write through it, and one cannot reach the other's domain either.
    const writes = await Promise.all([
      handleApi(request('POST', '/api/domains/1/apply-dmarc', { record: 'v=DMARC1; p=none' }), env, ctx, as('ws_a')),
      handleApi(request('POST', '/api/domains/2/apply-dmarc', { record: 'v=DMARC1; p=reject' }), env, ctx, as('ws_b')),
      handleApi(request('POST', '/api/domains/2/apply-dmarc', { record: 'v=DMARC1; p=none' }), env, ctx, as('ws_a')),
    ]);
    expect(writes.map(r => r.status)).toEqual([400, 400, 404]);
    expect((await writes[0].json() as any).code).toBe('cloudflare_not_connected');
    expect(cf.records.get('zone-a') ?? []).toEqual([]);
    expect(cf.records.get('zone-b') ?? []).toEqual([]);
  });

  it('the instance’s own workspace still writes through the server token, in the zone of the domain', async () => {
    const { db, env } = twoWorkspaceEnv();
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_default', 'home.example', 'rua@reports.home.example')").run();
    const cf = stubCloudflare(new FakeCloudflare({ 'home.example': { id: 'zone-home', cfAccountId: 'cf-home' } }));
    const res = await handleApi(request('POST', '/api/domains/3/apply-dmarc', { record: 'v=DMARC1; p=none' }), env, ctx, as('ws_default'));
    expect(res.status).toBe(200);
    expect(cf.records.get('zone-home')).toEqual([expect.objectContaining({ name: '_dmarc.home.example' })]);
  });

  it('keeps branding, from-address and telemetry opt-in per workspace', async () => {
    const { env } = twoWorkspaceEnv();
    const [a, b] = await Promise.all([
      loadTenant(env as any, { workspaceId: 'ws_a' }),
      loadTenant(env as any, { workspaceId: 'ws_b' }),
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
    const a = makeTenant({ workspaceId: 'ws_a', cfToken: 'tok-a', fetch: delayed(cfA) });
    const b = makeTenant({ workspaceId: 'ws_b', cfToken: 'tok-b', fetch: delayed(cfB) });

    const [za, zb] = await Promise.all([a.zoneFor('shared.com'), b.zoneFor('www.shared.com')]);
    expect(za.id).toBe('zone-shared-a');
    expect(zb.id).toBe('zone-shared-b');
    expect(cfA.calls[0].auth).toBe('Bearer tok-a');
    expect(cfB.calls[0].auth).toBe('Bearer tok-b');
  });
});

// The read-only analytics endpoints (src/analytics/routes.ts): each workspace's sender inventory, trend, fixes and
// readiness come only from its own domains, whichever domain id or window the caller asks for.
describe('analytics endpoints under concurrent tenants', () => {
  const OWN: Record<string, { ip: string; domain: string; id: number }> = {
    ws_a: { ip: '198.51.100.10', domain: 'a-corp.com', id: 1 },
    ws_b: { ip: '203.0.113.20', domain: 'b-corp.org', id: 2 },
  };

  async function seeded() {
    const { db, env } = twoWorkspaceEnv();
    for (const [ws, o] of Object.entries(OWN)) {
      await seedDomainReports(db, ws, o.id, o.domain, lastDays(10), [
        { ip: o.ip, count: 50, pass: false, spf: ['pass', 'mcsv.net'], dkim: ['pass', 'mcsv.net'], reverse_dns: 'mail1.mcsv.net', base_domain: 'mcsv.net' },
        { ip: '192.0.2.1', count: 50, pass: true },
      ]);
    }
    return { db, env };
  }

  it('workspace-wide and per-domain answers never include another workspace', async () => {
    const { env } = await seeded();
    vi.stubGlobal('fetch', async () => { await sleep(Math.random() * 10); return new Response(JSON.stringify({ Status: 3 })); });
    const ask = async (ws: string, path: string) => (await handleApi(request('GET', path), env, ctx, as(ws))).json() as Promise<any>;

    for (let i = 0; i < 4; i++) {
      const [wa, wb, da, db_] = await Promise.all([
        ask('ws_a', '/api/analytics?days=30'), ask('ws_b', '/api/analytics?days=30'),
        ask('ws_a', '/api/domains/1/analytics'), ask('ws_b', '/api/domains/2/analytics'),
      ]);
      for (const [ws, wide, one] of [['ws_a', wa, da], ['ws_b', wb, db_]] as const) {
        const mine = OWN[ws]!;
        const other = OWN[ws === 'ws_a' ? 'ws_b' : 'ws_a']!;
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

  it('a domain id from another workspace is a 404, in both directions', async () => {
    const { env } = await seeded();
    const status = async (ws: string, path: string) => (await handleApi(request('GET', path), env, ctx, as(ws))).status;
    expect(await status('ws_a', '/api/domains/2/analytics')).toBe(404);
    expect(await status('ws_b', '/api/domains/1/analytics')).toBe(404);
    expect(await status('ws_a', '/api/domains/1/analytics')).toBe(200);
  });
});
