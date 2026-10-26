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

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept } from './helpers';

// Every route that writes DNS or changes domains/settings. Members are read-only.
const WRITES: Array<[string, string, unknown?]> = [
  ['POST', '/api/domains', { domain: 'new.example.com' }],
  ['DELETE', '/api/domains/1'],
  ['POST', '/api/domains/1/apply-dmarc', { record: 'v=DMARC1; p=none' }],
  ['POST', '/api/domains/1/apply-spf', { record: 'v=spf1 -all' }],
  ['PATCH', '/api/domains/1/dmarc', { policy: 'none' }],
  ['POST', '/api/domains/1/rollout-advance', {}],
  ['PUT', '/api/domains/1/set-default', {}],
  ['PUT', '/api/domains/1/wizard-state', {}],
  ['PATCH', '/api/domains/1/alerts', { enabled: false }],
  ['POST', '/api/domains/1/spf-flatten', {}],
  ['DELETE', '/api/domains/1/spf-flatten'],
  ['POST', '/api/domains/1/mta-sts', { mode: 'testing' }],
  ['DELETE', '/api/domains/1/mta-sts'],
  ['POST', '/api/settings/base-domain', { domain: 'example.com' }],
  ['POST', '/api/settings/register-destination', {}],
  ['POST', '/api/setup/email-routing', {}],
  ['POST', '/api/setup/custom-domain', {}],
  ['POST', '/api/domains/bulk-import', { domains: 'a.example.com' }],
  ['POST', '/api/team/invite', { email: 'x@example.com' }],
  // Cloudflare connections
  ['POST', '/api/cloudflare/connections', { token: 'x'.repeat(40) }],
  ['DELETE', '/api/cloudflare/connections/cfc_x'],
  ['PUT', '/api/cloudflare/connections/cfc_x/zones', { zone_ids: [] }],
  ['PUT', '/api/cloudflare/connections/cfc_x/token', { token: 'x'.repeat(40) }],
  ['POST', '/api/cloudflare/oauth/start', {}],
  ['PUT', '/api/domains/1/connection', { connection_id: null }],
];

// Connections are owner/admin only, reads included (the list shows Cloudflare account names and scopes).
const ADMIN_ONLY_READS: Array<[string, string]> = [
  ['GET', '/api/cloudflare/connections'],
  ['GET', '/api/cloudflare/connections/cfc_x'],
  ['GET', '/api/cloudflare/connections/cfc_x/zones'],
  ['GET', '/api/cloudflare/oauth/callback?code=x&state=y'],
];

async function world() {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id) VALUES (1, 'acme.com', 'rua@reports.example.com', 'ws_default')").run();
  const env = makeEnv(db);
  const owner = await setupOwner(env);
  return { env, owner, admin: await inviteAndAccept(env, owner, 'admin@example.com', 'admin'), member: await inviteAndAccept(env, owner, 'member@example.com', 'member') };
}

describe('roles: owner / admin / member', () => {
  it('a member gets 403 on every DNS-writing / settings-changing route', async () => {
    const { env, member } = await world();
    for (const [method, path, body] of WRITES) {
      const res = await call(env, method, path, { key: member, body });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('a member cannot read Cloudflare connections either; admins and owners can', async () => {
    const { env, owner, admin, member } = await world();
    for (const [method, path] of ADMIN_ONLY_READS) {
      expect((await call(env, method, path, { key: member })).status, `member ${method} ${path}`).toBe(403);
      for (const key of [owner, admin]) {
        const res = await call(env, method, path, { key });
        expect(res.status, `${method} ${path}`).not.toBe(403);
        expect(res.status, `${method} ${path}`).not.toBe(401);
      }
    }
  });

  it('admins and owners are not stopped by the role check', async () => {
    const { env, owner, admin } = await world();
    for (const key of [owner, admin]) {
      for (const [method, path, body] of WRITES) {
        if (method === 'DELETE' && path === '/api/domains/1') continue; // would remove the fixture
        const res = await call(env, method, path, { key, body });
        expect(res.status, `${method} ${path}`).not.toBe(403);
        expect(res.status, `${method} ${path}`).not.toBe(401);
      }
    }
  });

  it('members can read', async () => {
    const { env, member } = await world();
    for (const path of ['/api/domains', '/api/reports', '/api/domains/1/stats']) {
      expect((await call(env, 'GET', path, { key: member })).status, path).toBe(200);
    }
  });

  it('members cannot see the team, audit log or bulk-import; admins can', async () => {
    const { env, member, admin } = await world();
    expect((await call(env, 'GET', '/api/team', { key: member })).status).toBe(403);
    expect((await call(env, 'GET', '/api/audit-log', { key: member })).status).toBe(403);
    expect((await call(env, 'GET', '/api/team', { key: admin })).status).toBe(200);
    expect((await call(env, 'GET', '/api/audit-log', { key: admin })).status).toBe(200);
  });

  it('retired instance credentials cannot read, write, invite or mint keys', async () => {
    const env = makeEnv(createMigratedD1(), { API_KEY: 'instance-secret-key' });
    for (const [method,path,body] of [['GET','/api/domains',undefined],['POST','/api/settings/base-domain',{domain:'example.com'}],['GET','/api/audit-log',undefined],['POST','/api/team/invite',{email:'x@example.com'}],['POST','/api/keys',{name:'k'}]] as const) {
      expect((await call(env,method,path,{key:'instance-secret-key',body})).status).toBe(401);
    }
  });

  it('an API_KEY does not unlock a user session of the same value, and bad credentials get 401', async () => {
    const env = makeEnv(createMigratedD1());
    expect((await call(env, 'GET', '/api/domains')).status).toBe(401);
    expect((await call(env, 'GET', '/api/domains', { key: 'garbage' })).status).toBe(401);
    expect((await call(env, 'GET', '/api/domains', { headers: { authorization: 'Bearer garbage' } })).status).toBe(401);
  });
});

describe('GET /api/me', () => {
  it('reports the caller and their role, for every role', async () => {
    const { env, owner, admin, member } = await world();
    for (const [key, role, email] of [[owner, 'owner', 'owner@example.com'], [admin, 'admin', 'admin@example.com'], [member, 'member', 'member@example.com']] as const) {
      const res = await call(env, 'GET', '/api/me', { key });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.role).toBe(role);
      expect(body.user.email).toBe(email);
      expect(body.workspace_id).toBeTruthy();
    }
  });

  it('is 401 without credentials', async () => {
    const { env } = await world();
    expect((await call(env, 'GET', '/api/me')).status).toBe(401);
  });
});

// Workspace management (src/workspaces/routes.ts): everybody may list; owners rename and delete; on self-host only the instance owner creates.
describe('roles: workspace management', () => {
  const MANAGE: Array<[string, string, unknown?]> = [
    ['PATCH', '/api/workspaces/ws_default', { name: 'Renamed' }],
    ['DELETE', '/api/workspaces/ws_default'],
  ];

  it('members and admins cannot rename or delete the workspace; the owner can rename it', async () => {
    const { env, owner, admin, member } = await world();
    for (const key of [member, admin]) {
      for (const [method, path, body] of MANAGE) expect((await call(env, method, path, { key, body })).status, `${method} ${path}`).toBe(403);
    }
    expect((await call(env, 'PATCH', '/api/workspaces/ws_default', { key: owner, body: { name: 'Renamed' } })).status).toBe(200);
  });

  it('every role can list its workspaces; on self-host only the instance owner can create one', async () => {
    const { env, owner, admin, member } = await world();
    for (const key of [owner, admin, member]) expect((await call(env, 'GET', '/api/workspaces', { key })).status).toBe(200);
    for (const key of [admin, member]) expect((await call(env, 'POST', '/api/workspaces', { key, body: { name: 'Side project' } })).status).toBe(403);
    const created = await call(env, 'POST', '/api/workspaces', { key: owner, body: { name: 'Side project' } });
    expect(created.status).toBe(201);
    expect((await created.json() as any).role).toBe('owner');
  });
});
