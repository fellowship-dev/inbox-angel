import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';
import { createMigratedD1, type TestD1 } from '@inbox-angel/db/testing';
import { IMPLICIT_ACCOUNT_ID } from '@inbox-angel/db';

// Mock auth so all requests pass with userId = 'org_test'
vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', accountId: 'acct_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

// Mock DNS provisioning so router tests don't hit Cloudflare
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-rec-1', recordName: 'acme.com._report._dmarc.reports.inboxangel.io', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { handleApi } from '../../src/api/router';
import { seedSettings } from '../helpers/tenant';
import * as authMod from '../../src/api/auth';
import * as dnsMod from '../../src/dns/provision';

// ── Helpers ───────────────────────────────────────────────────

const BASE = 'https://api.inboxangel.com';

type TestEnv = Env & { DB: TestD1 };

function makeEnv(): TestEnv {
  const DB = createMigratedD1();
  seedSettings(DB, { reports_domain: 'reports.inboxangel.io', from_email: 'check@reports.inboxangel.io' });
  return {
    DB,
    API_KEY: 'test-key',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_ZONE_ID: '',
    CLOUDFLARE_API_TOKEN: '',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    FROM_EMAIL: 'check@reports.inboxangel.io',
  } as unknown as TestEnv;
}

function seedDomain(env: TestEnv, d: { id: number; domain: string; dns_record_id?: string | null; parent_id?: number | null }) {
  env.DB.sqlite
    .prepare('INSERT INTO domains (id, account_id, domain, rua_address, dns_record_id, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.id, IMPLICIT_ACCOUNT_ID, d.domain, 'rua@reports.inboxangel.io', d.dns_record_id ?? null, d.parent_id ?? null);
}

function seedCheckResult(env: TestEnv, token: string, fromDomain = 'acme.com') {
  env.DB.sqlite
    .prepare("INSERT INTO check_results (from_email, from_domain, spf_record, dmarc_policy, dmarc_record, session_token, overall_status) VALUES (?, ?, 'v=spf1 -all', 'none', 'v=DMARC1; p=none', ?, 'protected')")
    .run(`a@${fromDomain}`, fromDomain, token);
}

function rows(env: TestEnv, sql: string, ...params: any[]): any[] {
  return env.DB.sqlite.prepare(sql).all(...params) as any[];
}

function req(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = { 'x-api-key': 'test-key' };
  if (body) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// ── /health ───────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 ok without auth', async () => {
    const res = await handleApi(req('GET', '/health'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it('includes a ts timestamp', async () => {
    const res = await handleApi(req('GET', '/health'), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(typeof body.ts).toBe('number');
  });

  it('includes semver version string', async () => {
    const res = await handleApi(req('GET', '/health'), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── 404 for unknown paths ─────────────────────────────────────

describe('unknown routes', () => {
  it('returns 404 for non-api path', async () => {
    const res = await handleApi(req('GET', '/unknown'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown /api/ sub-path', async () => {
    const res = await handleApi(req('GET', '/api/unknown'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

// ── Free check sessions (public, unauthenticated) ─────────────

describe('POST /api/check-sessions', () => {
  it('returns 201 with token and email', async () => {
    const res = await handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(typeof body.token).toBe('string');
    // Token is used directly as the local-part (no check- prefix)
    expect(body.email).toMatch(/^[a-z0-9]+@reports\.inboxangel\.io$/);
  });

  it('generates a unique token each call', async () => {
    const [a, b] = await Promise.all([
      handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx).then(r => r.json()) as any,
      handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx).then(r => r.json()) as any,
    ]);
    expect((a as any).token).not.toBe((b as any).token);
  });

  it('does not call requireAuth', async () => {
    await handleApi(req('POST', '/api/check-sessions'), makeEnv(), ctx);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
  });
});

describe('GET /api/check-sessions/:token', () => {
  it('returns 202 pending when no result yet', async () => {
    const res = await handleApi(req('GET', '/api/check-sessions/abc123'), makeEnv(), ctx);
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.status).toBe('pending');
  });

  it('returns 200 done when result exists', async () => {
    const env = makeEnv();
    seedCheckResult(env, 'abc123');
    const res = await handleApi(req('GET', '/api/check-sessions/abc123'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('done');
    expect(body.result.overall_status).toBe('protected');
  });

  it('does not call requireAuth', async () => {
    await handleApi(req('GET', '/api/check-sessions/abc123'), makeEnv(), ctx);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
  });
});

// ── Auth failure propagation ──────────────────────────────────

describe('auth failure', () => {
  it('returns 401 when requireAuth throws AuthError', async () => {
    vi.mocked(authMod.requireAuth).mockRejectedValueOnce(
      new authMod.AuthError('Missing Authorization')
    );
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toContain('Missing Authorization');
  });

  it('returns 403 when AuthError has status 403', async () => {
    vi.mocked(authMod.requireAuth).mockRejectedValueOnce(
      new authMod.AuthError('audience mismatch', 403)
    );
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(403);
  });
});

// ── GET /api/domains ──────────────────────────────────────────

describe('GET /api/domains', () => {
  it('returns empty domains array when none exist', async () => {
    const res = await handleApi(req('GET', '/api/domains'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.domains).toEqual([]);
  });


  it('returns domain list from DB', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const res = await handleApi(req('GET', '/api/domains'), env, ctx);
    const body = await res.json() as any;
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].domain).toBe('acme.com');
  });
});

// ── POST /api/domains ─────────────────────────────────────────
// addDomain flow: insertDomain → logAudit (fire-and-forget) → getDomainById
// Response shape: { domain: <domainRow>, rua_hint, auth_record }

describe('POST /api/domains', () => {
  it('returns 201 with domain row and rua_hint', async () => {
    const env = makeEnv();
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain.domain).toBe('acme.com');
    expect(body.rua_hint).toContain('rua=mailto:rua@reports.inboxangel.io');
    expect(rows(env, 'SELECT domain, account_id FROM domains')).toEqual([{ domain: 'acme.com', account_id: IMPLICIT_ACCOUNT_ID }]);
  });

  it('lowercases and trims the domain', async () => {
    const env = makeEnv();
    const res = await handleApi(req('POST', '/api/domains', { domain: '  ACME.COM  ' }), env, ctx);
    const body = await res.json() as any;
    expect(body.domain.domain).toBe('acme.com');
    expect(rows(env, 'SELECT domain FROM domains')).toEqual([{ domain: 'acme.com' }]);
  });

  it('returns 400 when domain is missing', async () => {
    const res = await handleApi(req('POST', '/api/domains', {}), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid domain format', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'not-a-domain' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const r = new Request(`${BASE}/api/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await handleApi(r, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate domain', async () => {
    const env = makeEnv();
    // insertDomain hits the UNIQUE constraint (no DNS provisioning on domain add anymore)
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), env, ctx);
    expect(res.status).toBe(409);
    expect(rows(env, 'SELECT id FROM domains')).toHaveLength(1);
  });

  it('uses fixed rua address rua@REPORTS_DOMAIN', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'my-company.io' }), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.rua_hint).toContain('rua=mailto:rua@reports.inboxangel.io');
  });

  it('does not call provisionDomain on domain add (DNS deferred to wizard)', async () => {
    await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    expect(dnsMod.provisionDomain).not.toHaveBeenCalled();
  });

  it('includes auth_record in the 201 response', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.auth_record).toContain('_report._dmarc.');
  });

  it('always returns dns_instructions for manual setup (no auto-provisioning)', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.dns_instructions).toContain('v=DMARC1;');
    expect(body.auth_record).toContain('_report._dmarc.');
  });
});

// ── Self-hosted lazy init ──────────────────────────────────────

describe('BASE_DOMAIN lazy init', () => {
  it('creates domain DB row on first authenticated request (no DNS writes)', async () => {
    const env = { ...makeEnv(), BASE_DOMAIN: 'myco.com' } as TestEnv;
    const res = await handleApi(req('GET', '/api/domains'), env, ctx);
    expect(res.status).toBe(200);
    expect(dnsMod.provisionDomain).not.toHaveBeenCalled();
  });

  it('skips lazy init when BASE_DOMAIN is not set', async () => {
    const env = makeEnv(); // no BASE_DOMAIN
    await handleApi(req('GET', '/api/domains'), env, ctx);
    expect(dnsMod.provisionDomain).not.toHaveBeenCalled();
    expect(rows(env, 'SELECT id FROM domains')).toEqual([]);
  });
});

// ── DELETE /api/domains/:id ───────────────────────────────────

describe('DELETE /api/domains/:id', () => {
  it('returns 204 when domain exists', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 5, domain: 'acme.com', dns_record_id: null });
    const res = await handleApi(req('DELETE', '/api/domains/5'), env, ctx);
    expect(res.status).toBe(204);
    expect(rows(env, 'SELECT id FROM domains')).toEqual([]);
  });

  it('calls deprovisionDomain when dns_record_id is set', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 5, domain: 'acme.com', dns_record_id: 'cf-rec-abc' });
    await handleApi(req('DELETE', '/api/domains/5'), env, ctx);
    expect(dnsMod.deprovisionDomain).toHaveBeenCalledWith(expect.anything(), 'cf-rec-abc');
  });

  it('returns 404 when domain not found', async () => {
    const env = makeEnv();
    const res = await handleApi(req('DELETE', '/api/domains/99'), env, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await handleApi(req('DELETE', '/api/domains/abc'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/domains/:id/stats ────────────────────────────────

describe('GET /api/domains/:id/stats', () => {
  it('returns stats for owned domain', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const day = Math.floor(Date.parse('2026-03-01T12:00:00Z') / 1000);
    env.DB.sqlite
      .prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (1, 'g', 'r1', ?, ?, 100, 95, 5)")
      .run(day, day + 3600);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-05T00:00:00Z'));
    let res: Response;
    try {
      res = await handleApi(req('GET', '/api/domains/1/stats'), env, ctx);
    } finally {
      vi.useRealTimers();
    }
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.domain).toBe('acme.com');
    expect(body.stats).toEqual([{ day: '2026-03-01', total: 100, passed: 95, failed: 5 }]);
    expect(body.days).toBe(30);
  });

  it('returns 400 for non-numeric domain id', async () => {
    const res = await handleApi(req('GET', '/api/domains/abc/stats'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('defaults to 30 days and caps at 90', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const res = await handleApi(req('GET', '/api/domains/1/stats?days=999'), env, ctx);
    const body = await res.json() as any;
    expect(body.days).toBe(90);
  });
});

// ── GET /api/reports ──────────────────────────────────────────

describe('GET /api/reports', () => {
  it('returns reports array', async () => {
    const res = await handleApi(req('GET', '/api/reports'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.reports)).toBe(true);
  });

  it('caps limit at 100', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const ins = env.DB.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end) VALUES (1, 'g', ?, 1, 2)");
    for (let i = 0; i < 150; i++) ins.run(`r${i}`);
    const res = await handleApi(req('GET', '/api/reports?limit=999'), env, ctx);
    const body = await res.json() as any;
    expect(body.reports).toHaveLength(100);
  });
});

// ── GET /api/reports/:id ──────────────────────────────────────

describe('GET /api/reports/:id', () => {
  it('returns 404 when report not found', async () => {
    const res = await handleApi(req('GET', '/api/reports/999'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await handleApi(req('GET', '/api/reports/abc'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns report + records when found', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    env.DB.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end) VALUES (1, 1, 'g', 'r1', 1, 2)").run();
    const res = await handleApi(req('GET', '/api/reports/1'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.report.id).toBe(1);
    expect(Array.isArray(body.records)).toBe(true);
  });
});

// ── POST /api/monitor ─────────────────────────────────────────

describe('POST /api/monitor', () => {
  it('returns 201 with domain and email when session exists', async () => {
    const env = makeEnv();
    seedCheckResult(env, 'tok123');
    const res = await handleApi(req('POST', '/api/monitor', { email: 'user@example.com', session_token: 'tok123' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain).toBe('acme.com');
    expect(body.email).toBe('user@example.com');
    expect(rows(env, 'SELECT email, domain FROM monitor_subscriptions')).toEqual([{ email: 'user@example.com', domain: 'acme.com' }]);
  });

  it('returns 400 when email is missing', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { session_token: 'tok123' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when session_token is missing', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { email: 'user@example.com' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { email: 'notanemail', session_token: 'tok' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when session token has no check result', async () => {
    const res = await handleApi(req('POST', '/api/monitor', { email: 'user@example.com', session_token: 'unknown' }), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('does not require auth', async () => {
    const env = makeEnv();
    seedCheckResult(env, 'tok123');
    await handleApi(req('POST', '/api/monitor', { email: 'u@x.com', session_token: 'tok123' }), env, ctx);
    expect(authMod.requireAuth).not.toHaveBeenCalled();
  });
});

// ── GET /api/check-results ────────────────────────────────────

describe('GET /api/check-results', () => {
  it('returns empty results when no domains exist', async () => {
    const res = await handleApi(req('GET', '/api/check-results'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
  });
});

// ── Wizard state endpoints ────────────────────────────────────

describe('GET /api/domains/:id/wizard-state', () => {
  it('returns default state when no wizard state saved', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const res = await handleApi(req('GET', '/api/domains/1/wizard-state'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf).toBe('not_started');
    expect(body.dkim).toBe('not_started');
    expect(body.dmarc).toBe('not_started');
    expect(body.routing).toBe('not_started');
  });

  it('returns saved wizard state', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const savedState = { spf: 'complete', dkim: 'skipped', dmarc: 'not_started', routing: 'not_started' };
    env.DB.sqlite.prepare('INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?)').run(IMPLICIT_ACCOUNT_ID, 'wizard_state_1', JSON.stringify(savedState));
    const res = await handleApi(req('GET', '/api/domains/1/wizard-state'), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf).toBe('complete');
    expect(body.dkim).toBe('skipped');
  });

  it('returns 400 for non-numeric id', async () => {
    const res = await handleApi(req('GET', '/api/domains/abc/wizard-state'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/domains/:id/wizard-state', () => {
  it('saves wizard state updates', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });
    const res = await handleApi(req('PUT', '/api/domains/1/wizard-state', { spf: 'complete' }), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf).toBe('complete');
    expect(body.dkim).toBe('not_started');
    const saved = rows(env, 'SELECT key, value FROM settings WHERE key LIKE ?', 'wizard_state_%');
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0].value).spf).toBe('complete');
  });

});

// ── Subdomain support (T017 + T018) ──────────────────────────
// T017: insertDomain auto-detects parent_id from existing domains
// T018: POST /api/domains with subdomain returns parent_context

describe('POST /api/domains — subdomain parent_context (T018)', () => {
  // Mock lookupDmarc so no real DNS is called
  vi.mock('../../src/email/dns-check', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
      ...actual,
      lookupDmarc: vi.fn().mockResolvedValue({ policy: 'reject', subdomainPolicy: 'reject', pct: 100, rua: [], ruf: [], raw: 'v=DMARC1; p=reject; sp=reject' }),
      lookupSpf: vi.fn().mockResolvedValue(null),
    };
  });

  it('returns parent_context when subdomain is added and parent exists in DB', async () => {
    const env = makeEnv();
    seedDomain(env, { id: 1, domain: 'acme.com' });

    const res = await handleApi(req('POST', '/api/domains', { domain: 'marketing.acme.com' }), env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.domain.domain).toBe('marketing.acme.com');
    expect(body.parent_context).toBeDefined();
    expect(body.parent_context.domain).toBe('acme.com');
    expect(body.parent_context.has_dmarc).toBe(true);
    expect(rows(env, 'SELECT parent_id FROM domains WHERE domain = ?', 'marketing.acme.com')).toEqual([{ parent_id: 1 }]);
  });

  it('returns no parent_context when apex domain is added', async () => {
    const res = await handleApi(req('POST', '/api/domains', { domain: 'acme.com' }), makeEnv(), ctx);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.parent_context).toBeUndefined();
  });
});

afterEach(() => vi.clearAllMocks());
