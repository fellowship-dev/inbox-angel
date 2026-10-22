import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', accountId: 'acct_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

const post = (domain: string) => new Request('https://x.test/api/settings/base-domain', {
  method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: JSON.stringify({ domain }),
});

describe('POST /api/settings/base-domain', () => {
  it('resolves the new domain\'s zone, replacing the previous domain\'s', async () => {
    const db = createMigratedD1();
    seedSettings(db, { base_domain: 'old.com', zone_id: 'zone-old', zone_name: 'old.com', account_id: 'cf' });
    stubCloudflare(new FakeCloudflare({ 'old.com': { id: 'zone-old', accountId: 'cf' }, 'new.com': { id: 'zone-new', accountId: 'cf' } }));
    const env = { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: 'tok' } as any;

    const res = await handleApi(post('new.com'), env, ctx);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ domain: 'new.com', reports_domain: 'reports.new.com', zone_id: 'zone-new', account_id: 'cf' });
    const row = (key: string) => (db.sqlite.prepare("SELECT value FROM settings WHERE account_id = 'acct_default' AND key = ?").get(key) as any)?.value;
    expect(row('zone_id')).toBe('zone-new');
    expect(row('zone_name')).toBe('new.com');
  });

  it('works without a Cloudflare token (zone stays unresolved)', async () => {
    const db = createMigratedD1();
    const env = { DB: db as unknown as D1Database, API_KEY: 'k' } as any;
    const res = await handleApi(post('acme.com'), env, ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ zone_id: null, account_id: null, reports_domain: 'reports.acme.com' });
  });
});
