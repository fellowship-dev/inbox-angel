// Regression tests for first-run setup auth.
// Uses the real requireAuth (not mocked) so credential resolution is exercised end to end.
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';

const LEGACY_KEY = 'legacy-auto-key-0000';
const BASE = 'https://ia.example.com';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// Real in-memory SQLite D1 with every migration applied, a fresh instance with
// no admin, and a legacy auto_api_key row in settings. Sessions and users are
// created by /api/auth/setup against the real schema.
function makeDb() {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('auto_api_key', ?)").run(LEGACY_KEY);
  return { db: db as unknown as D1Database };
}

function makeEnv(db: D1Database): Env {
  // No API_KEY: the self-host default where the legacy auto key used to apply.
  return { BOOTSTRAP_SECRET: 'test-only-installer-proof-32-characters-minimum', DB: db, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_ZONE_ID: '', CLOUDFLARE_API_TOKEN: '' } as unknown as Env;
}

function req(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = path === '/api/auth/setup' ? { 'x-inbox-angel-bootstrap': 'test-only-installer-proof-32-characters-minimum' } : {};
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

});
