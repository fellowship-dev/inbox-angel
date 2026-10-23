import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { FakeCloudflare } from '../helpers/cf-fake';
import { KEY } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function selfhost(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { CLOUDFLARE_API_TOKEN: 'env-tok-0123456789', ...extra }) as any;
  const owner = await setupOwner(env);
  const insert = db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, 'ws_default', ?, 'rua@x')");
  insert.run(1, 'home.com');
  insert.run(2, 'other.org');
  const cf = new FakeCloudflare({ 'home.com': { id: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', cfAccountId: 'cf-1' }, 'other.org': { id: 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', cfAccountId: 'cf-1' } });
  cf.accounts = [{ id: 'cf-1', name: 'Home' }];
  vi.stubGlobal('fetch', cf.fetch);
  const api = (method: string, path: string, body?: unknown) => call(env, method, path, { key: owner, body });
  return { db, env, cf, api, rows: (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[] };
}

describe('self-host: the env token keeps working', () => {
  it('serves domains with no connection through CLOUDFLARE_API_TOKEN, unchanged', async () => {
    const s = await selfhost();
    const res = await s.api('POST', '/api/domains/1/apply-dmarc', { record: 'v=DMARC1; p=none' });
    expect(res.status).toBe(200);
    expect(new Set(s.cf.forZone('e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1').map(c => c.auth))).toEqual(new Set(['Bearer env-tok-0123456789']));
  });

  it('shows it as an implicit token connection that cannot be edited', async () => {
    const s = await selfhost();
    const list = await (await s.api('GET', '/api/cloudflare/connections')).json() as any;
    expect(list.connections[0]).toMatchObject({ id: 'env', implicit: true, auth_type: 'token', status: 'active' });
    expect(JSON.stringify(list)).not.toContain('env-tok');
    for (const [m, p, b] of [['DELETE', '/api/cloudflare/connections/env'], ['PUT', '/api/cloudflare/connections/env/zones', { zone_ids: [] }], ['PUT', '/api/cloudflare/connections/env/token', { token: 'x'.repeat(30) }]] as [string, string, unknown?][]) {
      expect((await s.api(m, p, b)).status, `${m} ${p}`).toBe(400);
    }
    // linking to "env" means "no stored connection"
    expect((await s.api('PUT', '/api/domains/1/connection', { connection_id: 'env' })).status).toBe(200);
  });

  it('without an env token there is no implicit connection', async () => {
    const s = await selfhost({ CLOUDFLARE_API_TOKEN: '' });
    const list = await (await s.api('GET', '/api/cloudflare/connections')).json() as any;
    expect(list.connections).toEqual([]);
    expect((await s.api('POST', '/api/domains/1/apply-dmarc', { record: 'v=DMARC1; p=none' })).status).toBe(400);
  });

  it('a domain linked to a stored connection uses it, while the others keep the env token', async () => {
    const s = await selfhost({ TOKEN_ENCRYPTION_KEY: `k1:${KEY}` });
    s.cf.validTokens = new Set(['env-tok-0123456789', 'tok-pasted-1234567890abcdef']);
    const added = await (await s.api('POST', '/api/cloudflare/connections', { token: 'tok-pasted-1234567890abcdef', label: 'Other' })).json() as any;
    const id = added.connection.id;
    expect((await s.api('PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: ['e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2'] })).status).toBe(200);
    expect((await s.api('PUT', '/api/domains/2/connection', { connection_id: id })).status).toBe(200);

    s.cf.calls.length = 0;
    expect((await s.api('POST', '/api/domains/1/apply-dmarc', { record: 'v=DMARC1; p=none' })).status).toBe(200);
    expect((await s.api('POST', '/api/domains/2/apply-dmarc', { record: 'v=DMARC1; p=none' })).status).toBe(200);
    expect(new Set(s.cf.forZone('e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1').map(c => c.auth))).toEqual(new Set(['Bearer env-tok-0123456789']));
    expect(new Set(s.cf.forZone('e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2').map(c => c.auth))).toEqual(new Set(['Bearer tok-pasted-1234567890abcdef']));
    // the list shows the implicit connection first, then the stored one
    const list = (await (await s.api('GET', '/api/cloudflare/connections')).json() as any).connections;
    expect(list.map((c: any) => c.id)).toEqual(['env', id]);
  });
});
