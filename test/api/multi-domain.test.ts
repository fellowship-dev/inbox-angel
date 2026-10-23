import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';

// Mock auth so all requests pass
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { seedSettings } from '../helpers/tenant';
import { loadTenant } from '../../src/tenancy/load';

const BASE = 'https://api.inboxangel.com';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'x-api-key': 'test-key' };
  if (body) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeEnv(): Env {
  const DB = createMigratedD1();
  seedSettings(DB, { reports_domain: 'reports.example.com', from_email: 'noreply@reports.example.com' });
  return {
    DB: DB as unknown as D1Database,
    API_KEY: 'test-key',
    CLOUDFLARE_API_TOKEN: 'tok-test',
  };
}

// ── GET /api/zones ─────────────────────────────────────────────

describe('GET /api/zones', () => {
  it('returns 200 with zones list when CF API responds', async () => {
    const env = makeEnv();
    const mockZones = [{ id: 'z1', name: 'example.com', status: 'active' }];

    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, result: mockZones }), { status: 200 }));

    const res = await handleApi(req('GET', '/api/zones'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0].name).toBe('example.com');
  });

  it('returns 400 when CLOUDFLARE_API_TOKEN is not set', async () => {
    const env = { ...makeEnv(), CLOUDFLARE_API_TOKEN: undefined };
    const res = await handleApi(req('GET', '/api/zones'), env, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 502 when CF API reports failure', async () => {
    const env = makeEnv();
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, errors: [{ message: 'Unauthorized' }] }), { status: 200 }));

    const res = await handleApi(req('GET', '/api/zones'), env, ctx);
    expect(res.status).toBe(502);
  });
});

// ── PUT /api/domains/:id/set-default ──────────────────────────

describe('PUT /api/domains/:id/set-default', () => {
  it('returns 200 with warning on success', async () => {
    const env = makeEnv();
    const sqlite = (env.DB as any).sqlite;
    sqlite.exec("INSERT INTO domains (id, domain, rua_address, is_default) VALUES (1, 'old.com', 'r@x.com', 1), (3, 'example.com', 'r@x.com', 0)");

    const res = await handleApi(req('PUT', '/api/domains/3/set-default'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.warning).toBe('string');
    // is_default is atomically swapped to the target
    expect(sqlite.prepare('SELECT id FROM domains WHERE is_default = 1').all()).toEqual([{ id: 3 }]);
  });

  it('returns 404 when domain does not exist', async () => {
    const env = makeEnv();
    const res = await handleApi(req('PUT', '/api/domains/999/set-default'), env, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const env = makeEnv();
    const res = await handleApi(req('PUT', '/api/domains/abc/set-default'), env, ctx);
    expect(res.status).toBe(400);
  });
});

// ── loadTenant() default domain fallback (unit) ────────────────

describe('loadTenant() fallback to is_default=1', () => {
  it('derives the base domain from the default domain when base_domain is not in settings', async () => {
    const db = createMigratedD1();
    // no base_domain in settings, but a default domain exists
    db.sqlite.exec("INSERT INTO domains (id, domain, rua_address, is_default) VALUES (1, 'fallback.com', 'r@x.com', 1)");

    const tenant = await loadTenant({ DB: db } as any, { workspaceId: 'ws_default' });

    expect(tenant.settings.baseDomain).toBe('fallback.com');
    expect(tenant.settings.reportsDomain).toBe('reports.fallback.com');
    expect(tenant.settings.fromEmail).toBe('noreply@reports.fallback.com');
  });
});
