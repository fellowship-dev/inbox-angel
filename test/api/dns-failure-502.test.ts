// Routes that call live DNS must answer 502 (not throw out of handleApi) when DNS fails.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', accountId: 'acct_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error { constructor(m: string, public status = 401) { super(m); } },
}));
vi.mock('../../src/dns/provision', () => ({ provisionDomain: vi.fn(), deprovisionDomain: vi.fn(), DnsProvisionError: class extends Error {} }));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const DOMAIN = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.test.com' };

function makeEnv(): Env {
  const db = createMigratedD1();
  db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address) VALUES (?, ?, ?)').run(DOMAIN.id, DOMAIN.domain, DOMAIN.rua_address);
  seedSettings(db, { reports_domain: 'reports.test.com', from_email: 'noreply@reports.test.com' });
  db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, enabled, mode, mx_hosts, policy_id, mta_sts_record_id) VALUES (?, 1, 'testing', ?, '1', 'rec')").run(DOMAIN.id, JSON.stringify(['a.acme.com']));
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'tok' } as unknown as Env;
}

const send = (method: string, path: string, body?: unknown) =>
  handleApi(new Request(`https://api.inboxangel.com${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), makeEnv(), ctx);

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Status: 2 }), { status: 200 }))));
afterEach(() => vi.unstubAllGlobals());

describe('DNS failure → 502', () => {
  it('POST /spf-flatten when the SPF lookup fails', async () => {
    const res = await send('POST', '/api/domains/1/spf-flatten', {});
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/DNS lookup failed/);
  });
  it('PATCH /mta-sts refresh_mx when the MX lookup fails', async () => {
    const res = await send('PATCH', '/api/domains/1/mta-sts', { refresh_mx: true });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/DNS lookup failed/);
  });
});
