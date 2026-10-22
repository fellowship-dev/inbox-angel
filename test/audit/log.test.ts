import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { IMPLICIT_ACCOUNT_ID } from '@inbox-angel/db';

// Mock auth so all requests pass with userId = 'org_test'
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock DNS provisioning so tests don't hit Cloudflare
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', recordName: 'test._report._dmarc.reports.inboxangel.io', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { logAudit, AuditEntry } from '../../src/audit/log';
import { scope } from '../../src/db/scope';
import { handleApi } from '../../src/api/router';

// ── Helpers ───────────────────────────────────────────────────

const BASE = 'https://api.inboxangel.com';

type TestDb = ReturnType<typeof createMigratedD1>;
type AuditRow = Record<string, any>;

function auditRows(db: TestDb): AuditRow[] {
  return db.sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all() as AuditRow[];
}

function seedAudit(db: TestDb, id: number, action: string, createdAt: number) {
  db.sqlite
    .prepare('INSERT INTO audit_log (id, account_id, action, created_at) VALUES (?, ?, ?, ?)')
    .run(id, IMPLICIT_ACCOUNT_ID, action, createdAt);
}

function seedUser(db: TestDb, id: string, role: string) {
  db.sqlite
    .prepare("INSERT INTO users (id, email, name, role, session_token) VALUES (?, ?, ?, ?, 'test-key')")
    .run(id, `${id}@test.com`, id, role);
}

function makeEnv(db: TestDb): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    API_KEY: 'test-key',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    FROM_EMAIL: 'check@reports.inboxangel.io',
  };
}

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// ── logAudit() unit tests ────────────────────────────────────

describe('logAudit()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Run logAudit with a ctx and await the promise handed to waitUntil. */
  async function logAndFlush(db: TestDb, entry: AuditEntry) {
    const waitUntil = vi.fn();
    logAudit({ db: db as unknown as D1Database, accountId: IMPLICIT_ACCOUNT_ID }, entry, { waitUntil } as unknown as ExecutionContext);
    await waitUntil.mock.calls[0][0];
  }

  it('writes an entry to the DB with correct fields', async () => {
    const db = createMigratedD1();
    const entry: AuditEntry = {
      actor_id: 'user-1',
      actor_email: 'user@test.com',
      actor_type: 'user',
      action: 'domain.add',
      resource_type: 'domain',
      resource_id: '42',
      resource_name: 'example.com',
      after_value: { domain: 'example.com' },
    };

    await logAndFlush(db, entry);

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.account_id).toBe(IMPLICIT_ACCOUNT_ID);
    expect(r.actor_id).toBe('user-1');
    expect(r.actor_email).toBe('user@test.com');
    expect(r.actor_type).toBe('user');
    expect(r.action).toBe('domain.add');
    expect(r.resource_type).toBe('domain');
    expect(r.resource_id).toBe('42');
    expect(r.resource_name).toBe('example.com');
  });

  it('serializes before_value/after_value as JSON strings', async () => {
    const db = createMigratedD1();
    await logAndFlush(db, {
      action: 'test.action',
      before_value: { old: true },
      after_value: { new: true, count: 5 },
    });

    const r = auditRows(db)[0];
    expect(r.before_value).toBe(JSON.stringify({ old: true }));
    expect(r.after_value).toBe(JSON.stringify({ new: true, count: 5 }));
  });

  it('does not throw on DB error (fire-and-forget)', async () => {
    const db = createMigratedD1();
    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('DB write failed');
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    expect(() => {
      logAudit({ db: db as unknown as D1Database, accountId: IMPLICIT_ACCOUNT_ID }, { action: 'test.action' });
    }).not.toThrow();

    // Wait for rejection to be caught
    await new Promise(r => setTimeout(r, 50));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[audit] log failed:'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('sets actor_type default to user', async () => {
    const db = createMigratedD1();
    await logAndFlush(db, {
      action: 'test.action',
      // actor_type NOT provided — should default to 'user'
    });

    expect(auditRows(db)[0].actor_type).toBe('user');
  });

  it('uses ctx.waitUntil when ctx is provided', () => {
    const db = createMigratedD1();
    const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    logAudit({ db: db as unknown as D1Database, accountId: IMPLICIT_ACCOUNT_ID }, {
      action: 'test.action',
    }, mockCtx);

    expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);
  });
});

// ── audit.list() tests (via DB queries) ──────────────────────

describe('getAuditLog()', () => {
  it('returns entries paginated', async () => {
    const db = createMigratedD1();
    seedAudit(db, 1, 'domain.add', 1000);
    seedAudit(db, 2, 'domain.remove', 2000);

    const result = await scope(db as unknown as D1Database, IMPLICIT_ACCOUNT_ID).audit.list({ page: 1, limit: 50 });

    // newest first
    expect(result.map(r => r.id)).toEqual([2, 1]);
    expect(result.map(r => r.action)).toEqual(['domain.remove', 'domain.add']);

    // limit/offset applied
    const page2 = await scope(db as unknown as D1Database, IMPLICIT_ACCOUNT_ID).audit.list({ page: 2, limit: 1 });
    expect(page2.map(r => r.id)).toEqual([1]);
  });

  it('filters by action prefix', async () => {
    const db = createMigratedD1();
    seedAudit(db, 1, 'dns.provision', 1000);
    seedAudit(db, 2, 'dns.remove', 2000);
    seedAudit(db, 3, 'domain.add', 3000);

    const result = await scope(db as unknown as D1Database, IMPLICIT_ACCOUNT_ID).audit.list({ action: 'dns' });
    expect(result.map(r => r.action).sort()).toEqual(['dns.provision', 'dns.remove']);
  });

  it('filters by date range (since/until)', async () => {
    const db = createMigratedD1();
    seedAudit(db, 1, 'a', 500);
    seedAudit(db, 2, 'b', 1000);
    seedAudit(db, 3, 'c', 1500);
    seedAudit(db, 4, 'd', 2000);
    seedAudit(db, 5, 'e', 2500);

    const result = await scope(db as unknown as D1Database, IMPLICIT_ACCOUNT_ID).audit.list({ since: 1000, until: 2000 });
    expect(result.map(r => r.id).sort()).toEqual([2, 3, 4]);
  });
});

// ── GET /api/audit-log route tests ───────────────────────────

describe('GET /api/audit-log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for non-admin user', async () => {
    const db = createMigratedD1();
    seedUser(db, 'user-1', 'member');

    const env = makeEnv(db);
    // Remove API_KEY so it falls through to session-based auth
    delete (env as any).API_KEY;
    const res = await handleApi(
      req('GET', '/api/audit-log', undefined, { 'x-api-key': 'test-key' }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain('admin');
  });

  it('returns entries for admin user', async () => {
    const db = createMigratedD1();
    seedUser(db, 'admin-1', 'admin');
    seedAudit(db, 1, 'domain.add', 1000);

    const env = makeEnv(db);
    delete (env as any).API_KEY;
    const res = await handleApi(
      req('GET', '/api/audit-log', undefined, { 'x-api-key': 'test-key' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ id: 1, action: 'domain.add', created_at: 1000 });
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });
});
