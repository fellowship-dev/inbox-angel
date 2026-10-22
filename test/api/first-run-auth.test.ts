// Regression tests for first-run setup auth.
// Uses the real requireAuth (not mocked) so credential resolution is exercised end to end.
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue(undefined),
    getAccountId: vi.fn().mockReturnValue(undefined),
    getBaseDomain: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.example.com'),
    fromEmail: vi.fn().mockReturnValue('noreply@reports.example.com'),
  };
});

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleApi } from '../../src/api/router';
import { ensureMigrated } from '../../src/db/migrate';

const LEGACY_KEY = 'legacy-auto-key-0000';
const BASE = 'https://ia.example.com';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// Minimal SQL-aware D1 mock: a fresh instance with no admin, a legacy
// auto_api_key row in settings, and sessions created by /api/auth/setup.
function makeDb() {
  const state = {
    sessions: new Map<string, { id: string; email: string; role: string }>(),
    users: [] as { id: string; email: string; role: string }[],
    sql: [] as string[],
  };
  const resolveFirst = (sql: string, params: unknown[]) => {
    if (sql.includes("key = 'auto_api_key'") || (sql.includes('FROM settings') && params[0] === 'auto_api_key')) {
      return { key: 'auto_api_key', value: LEGACY_KEY };
    }
    if (sql.includes('FROM users') && sql.includes('session_token')) {
      const u = state.sessions.get(String(params[0]));
      return u ? { ...u, name: u.email, session_token: params[0] } : null;
    }
    if (sql.includes('FROM users') && sql.includes("role = 'admin'")) {
      return state.users.find(u => u.role === 'admin') ?? null;
    }
    return null;
  };
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => stmt(sql, args),
    first: vi.fn(async () => resolveFirst(sql, params)),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => {
      if (/INSERT INTO users/i.test(sql)) {
        state.users.push({ id: String(params[0]), email: String(params[1]), role: String(params.find(p => p === 'admin' || p === 'member') ?? 'member') });
      }
      if (/UPDATE users SET session_token/i.test(sql)) {
        const [token, id] = params as string[];
        const u = state.users.find(x => x.id === id);
        if (u) state.sessions.set(token, u);
      }
      return { success: true, meta: { last_row_id: 1 } };
    }),
  });
  const db = {
    prepare: vi.fn((sql: string) => { state.sql.push(sql); return stmt(sql); }),
    batch: vi.fn(async () => []),
  };
  return { db: db as unknown as D1Database, state };
}

function makeEnv(db: D1Database): Env {
  // No API_KEY: the self-host default where the legacy auto key used to apply.
  return { DB: db, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_ZONE_ID: '', CLOUDFLARE_API_TOKEN: '' } as unknown as Env;
}

function req(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.key) headers['x-api-key'] = opts.key;
  if (opts.body) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
}

describe('first-run setup auth', () => {
  it('GET /api/init-key unauthenticated returns no key', async () => {
    const { db } = makeDb();
    const res = await handleApi(req('GET', '/api/init-key'), makeEnv(db), ctx);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(LEGACY_KEY);
    expect(text).not.toContain('"key"');
  });

  it('rejects the legacy auto-generated key as a credential', async () => {
    const { db } = makeDb();
    const res = await handleApi(req('GET', '/api/domains', { key: LEGACY_KEY }), makeEnv(db), ctx);
    expect(res.status).toBe(401);
  });

  it('rejects requests with no credential when API_KEY is unset', async () => {
    const { db } = makeDb();
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(db), ctx);
    expect(res.status).toBe(401);
  });

  it('first-run setup still works: status → setup → authenticated call', async () => {
    const { db } = makeDb();
    const env = makeEnv(db);

    const status = await handleApi(req('GET', '/api/auth/status'), env, ctx);
    expect(status.status).toBe(200);
    const s = await status.json() as { configured: boolean };
    expect(s.configured).toBe(false);
    expect(JSON.stringify(s)).not.toContain(LEGACY_KEY);

    const setup = await handleApi(
      req('POST', '/api/auth/setup', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } }),
      env, ctx,
    );
    expect(setup.status).toBe(201);
    const { token } = await setup.json() as { token: string };
    expect(token).toBeTruthy();
    expect(token).not.toBe(LEGACY_KEY);

    const domains = await handleApi(req('GET', '/api/domains', { key: token }), env, ctx);
    expect(domains.status).toBe(200);

    // Setup is closed once an admin exists.
    const again = await handleApi(
      req('POST', '/api/auth/setup', { body: { email: 'other@example.com', password: 'another-password' } }),
      env, ctx,
    );
    expect(again.status).toBe(409);
  });

  it('migration no longer creates an auto key and removes a legacy one', async () => {
    const { db, state } = makeDb();
    await ensureMigrated(db);
    expect(state.sql.some(q => /INSERT[^;]*auto_api_key/i.test(q))).toBe(false);
    expect(state.sql.some(q => /DELETE FROM settings WHERE key = 'auto_api_key'/.test(q))).toBe(true);
  });
});
