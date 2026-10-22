import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Env } from '../../src/index';

// Mock auth so all requests pass
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock env-utils — enrichEnv is no-op, reportsDomain returns test value
vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue(undefined),
    getAccountId: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.example.com'),
    fromEmail: vi.fn().mockReturnValue('noreply@reports.example.com'),
    getBaseDomain: vi.fn().mockReturnValue('example.com'),
    getWorkersSubdomain: vi.fn().mockReturnValue(undefined),
    resetEnvCache: vi.fn(),
  };
});

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';

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
  return {
    DB: createMigratedD1() as unknown as D1Database,
    API_KEY: 'test-key',
    CLOUDFLARE_API_TOKEN: 'tok-test',
  };
}

// ── GET /api/zones ─────────────────────────────────────────────

describe('GET /api/zones', () => {
  it('returns 200 with zones list when CF API responds', async () => {
    const env = makeEnv();
    const mockZones = [{ id: 'z1', name: 'example.com', status: 'active' }];

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, result: mockZones }),
    } as unknown as Response);

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
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, errors: [{ message: 'Unauthorized' }] }),
    } as unknown as Response);

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

// ── Migration 0005 backfill SQL ────────────────────────────────

describe('migration 0005 backfill', () => {
  const migrationSql = readFileSync(
    join(__dirname, '../../migrations/0006_add_is_default.sql'),
    'utf-8'
  );

  it('adds is_default column with DEFAULT 0', () => {
    expect(migrationSql).toContain('ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
  });

  it('backfills is_default=1 only when exactly one domain exists', () => {
    // Backfill uses COUNT(*) = 1 guard so multi-domain deploys are unaffected
    expect(migrationSql).toContain("COUNT(*) FROM domains) = 1");
  });

  it('backfills the oldest domain (order by created_at ASC)', () => {
    expect(migrationSql).toContain('ORDER BY created_at ASC LIMIT 1');
  });

  it('creates unique index on is_default to enforce single default', () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX.*is_default.*WHERE is_default = 1/s);
  });
});

// ── enrichEnv() default domain fallback (unit) ─────────────────

describe('enrichEnv() fallback to is_default=1', () => {
  it('queries domains table when base_domain not in settings', async () => {
    // Import actual (unmocked) enrichEnv by bypassing the vi.mock
    const { enrichEnv, resetEnvCache } = await vi.importActual<typeof import('../../src/env-utils')>('../../src/env-utils');

    // Reset caches so enrichEnv reads fresh
    resetEnvCache();

    const db = createMigratedD1();
    // no base_domain in settings, but a default domain exists
    db.sqlite.exec("INSERT INTO domains (id, domain, rua_address, is_default) VALUES (1, 'fallback.com', 'r@x.com', 1)");

    const fakeEnv = { DB: db, CLOUDFLARE_API_TOKEN: undefined } as any;
    await enrichEnv(fakeEnv, db as unknown as D1Database);

    // The base domain is derived from the is_default=1 domain
    const { getBaseDomain } = await vi.importActual<typeof import('../../src/env-utils')>('../../src/env-utils');
    expect(getBaseDomain()).toBe('fallback.com');
  });
});
