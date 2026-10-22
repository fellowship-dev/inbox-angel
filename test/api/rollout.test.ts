import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';
import type { Domain } from '../../src/db/types';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue(undefined),
    getAccountId: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.example.com'),
    fromEmail: vi.fn().mockReturnValue('check@reports.example.com'),
    getWorkersSubdomain: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'cf-1', recordName: 'acme.com._report._dmarc.reports.example.com', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'DnsProvisionError'; }
  },
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';

const BASE = 'https://api.example.com';
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

const domain: Partial<Domain> = {
  id: 5,
  domain: 'acme.com',
  rua_address: 'rua@reports.example.com',
  dmarc_policy: 'quarantine',
  dmarc_pct: 10,
  rollout_rec_policy: null,
  rollout_rec_pct: null,
};

function makeEnv(domainRow: Partial<Domain> | null = domain): Env {
  const db = createMigratedD1();
  if (domainRow) {
    db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dmarc_policy, dmarc_pct) VALUES (?, ?, ?, ?, ?)')
      .run(domainRow.id!, domainRow.domain!, domainRow.rua_address!, domainRow.dmarc_policy ?? null, domainRow.dmarc_pct ?? null);
  }
  return { DB: db as unknown as D1Database, API_KEY: 'test-key' } as Env;
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

// ── POST /api/domains/:id/rollout-advance ─────────────────────

describe('POST /api/domains/:id/rollout-advance', () => {
  it('persists a testing (t=y) step', async () => {
    const env = makeEnv();
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'quarantine', testing: true }), env, ctx);
    expect(res.status).toBe(200);
    expect((env.DB as any).sqlite.prepare('SELECT rollout_rec_policy, rollout_rec_pct FROM domains WHERE id = 5').get())
      .toMatchObject({ rollout_rec_policy: 'quarantine', rollout_rec_pct: 0 });
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.rollout_rec_policy).toBe('quarantine');
    expect(body.rollout_rec_pct).toBe(0);
    expect(body.rollout_rec_testing).toBe(true);
  });

  it('persists an enforced step', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'reject', testing: false }), makeEnv(), ctx);
    const body = await res.json() as any;
    expect(body.rollout_rec_policy).toBe('reject');
    expect(body.rollout_rec_pct).toBe(100);
    expect(body.rollout_rec_testing).toBe(false);
  });

  it('maps legacy pct requests to the fully enforced step (never weaker)', async () => {
    for (const pct of [10, 50, 100]) {
      const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'quarantine', pct }), makeEnv(), ctx);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.rollout_rec_policy).toBe('quarantine');
      expect(body.rollout_rec_pct).toBe(100);
    }
  });

  it('returns 404 when domain not found', async () => {
    const res = await handleApi(req('POST', '/api/domains/999/rollout-advance', { policy: 'quarantine', testing: true }), makeEnv(null), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid policy', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'none', testing: true }), makeEnv(), ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('quarantine or reject');
  });

  it('returns 400 for invalid legacy pct', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'quarantine', pct: 75 }), makeEnv(), ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('pct must be 10, 50, or 100');
  });

  it('returns 400 for non-boolean testing', async () => {
    const res = await handleApi(req('POST', '/api/domains/5/rollout-advance', { policy: 'quarantine', testing: 'yes' }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid domain id', async () => {
    const res = await handleApi(req('POST', '/api/domains/abc/rollout-advance', { policy: 'quarantine', testing: true }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});
