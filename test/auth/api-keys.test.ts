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

const rows = (db: ReturnType<typeof createMigratedD1>, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

async function createKey(env: Env, token: string, body: unknown = { name: 'ci' }) {
  const res = await call(env, 'POST', '/api/keys', { key: token, body });
  return { res, body: await res.clone().json() as any };
}

describe('per-user API keys', () => {
  it('revoke-all kills every key of the caller, and only theirs', async () => {
    const env = makeEnv();
    const owner = await setupOwner(env);
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const a = (await createKey(env, owner, { name: 'a' })).body;
    const b = (await createKey(env, owner, { name: 'b' })).body;
    const m = (await createKey(env, member, { name: 'm' })).body;
    const res = await call(env, 'POST', '/api/keys/revoke-all', { key: owner, body: {} });
    expect(await res.json()).toEqual({ ok: true, revoked: 2 });
    for (const k of [a, b]) expect((await call(env, 'GET', '/api/domains', { key: k.key })).status).toBe(401);
    expect((await call(env, 'GET', '/api/domains', { key: m.key })).status).toBe(200);
  });

  it('creates a key shown once, stored only as a hash, and authenticates as its owner', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const { res, body } = await createKey(env, owner, { name: 'deploy bot' });
    expect(res.status).toBe(201);
    expect(body.key).toMatch(/^ia_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.key.slice(0, 8));

    const stored = rows(db, 'SELECT * FROM api_keys');
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).not.toContain(body.key);
    expect(stored[0]).toMatchObject({ workspace_id: 'ws_default', name: 'deploy bot', prefix: body.prefix, revoked_at: null, last_used_at: null });
    expect(stored[0].key_hash).toMatch(/^[0-9a-f]{64}$/);

    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(200);
    expect((await call(env, 'GET', '/api/domains', { headers: { authorization: `Bearer ${body.key}` } })).status).toBe(200);
    expect((await call(env, 'GET', '/api/domains', { key: body.key + 'x' })).status).toBe(401);
  });

  it('lists prefixes only, and records last use', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const { body } = await createKey(env, owner);
    await call(env, 'GET', '/api/domains', { key: body.key });

    const list = await (await call(env, 'GET', '/api/keys', { key: owner })).json() as any;
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).toMatchObject({ id: body.id, name: 'ci', prefix: body.prefix });
    expect(list.keys[0].last_used_at).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(body.key);
    expect(Object.keys(list.keys[0])).not.toContain('key_hash');
  });

  it('revoking stops the key immediately', async () => {
    const env = makeEnv();
    const owner = await setupOwner(env);
    const { body } = await createKey(env, owner);
    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(200);
    expect((await call(env, 'DELETE', `/api/keys/${body.id}`, { key: owner })).status).toBe(200);
    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(401);
    expect((await call(env, 'DELETE', `/api/keys/${body.id}`, { key: owner })).status).toBe(404);
    expect(((await (await call(env, 'GET', '/api/keys', { key: owner })).json()) as any).keys).toEqual([]);
  });

  it('expired keys stop working', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const { body } = await createKey(env, owner, { name: 'short', expires_in_days: 1 });
    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(200);
    db.sqlite.prepare('UPDATE api_keys SET expires_at = 1').run();
    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(401);
  });

  it('a key carries its owner’s current role: a member’s key cannot write, and demotion/removal limits it', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const { body } = await createKey(env, member, { name: 'mine' });

    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(200);
    expect((await call(env, 'POST', '/api/domains', { key: body.key, body: { domain: 'x.example.com' } })).status).toBe(403);

    // promote then demote in place
    db.sqlite.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = (SELECT id FROM users WHERE email = 'm@example.com')").run();
    expect((await call(env, 'POST', '/api/settings/base-domain', { key: body.key, body: { domain: 'example.com' } })).status).toBeLessThan(300);
    db.sqlite.prepare("UPDATE memberships SET role = 'member' WHERE user_id = (SELECT id FROM users WHERE email = 'm@example.com')").run();
    expect((await call(env, 'POST', '/api/settings/base-domain', { key: body.key, body: { domain: 'example.com' } })).status).toBe(403);

    // removed from the team: key is dead
    const team = await (await call(env, 'GET', '/api/team', { key: owner })).json() as any;
    const id = team.users.find((u: any) => u.email === 'm@example.com').id;
    await call(env, 'DELETE', `/api/team/${id}`, { key: owner });
    expect((await call(env, 'GET', '/api/domains', { key: body.key })).status).toBe(401);
  });

  it('keys cannot mint keys, and members only see and revoke their own', async () => {
    const env = makeEnv();
    const owner = await setupOwner(env);
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const ownerKey = (await createKey(env, owner, { name: 'owner key' })).body;
    const memberKey = (await createKey(env, member, { name: 'member key' })).body;

    expect((await call(env, 'POST', '/api/keys', { key: ownerKey.key, body: { name: 'child' } })).status).toBe(403);

    const memberList = await (await call(env, 'GET', '/api/keys', { key: member })).json() as any;
    expect(memberList.keys.map((k: any) => k.name)).toEqual(['member key']);
    const ownerList = await (await call(env, 'GET', '/api/keys', { key: owner })).json() as any;
    expect(ownerList.keys.map((k: any) => k.name).sort()).toEqual(['member key', 'owner key']);

    expect((await call(env, 'DELETE', `/api/keys/${ownerKey.id}`, { key: member })).status).toBe(404);
    expect((await call(env, 'DELETE', `/api/keys/${memberKey.id}`, { key: owner })).status).toBe(200);
  });

  it('is scoped to its workspace: a key resolves to the workspace it was created in', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    await call(env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } });
    const m = rows(db, 'SELECT user_id, workspace_id FROM memberships')[0];
    const { createApiKey } = await import('../../src/auth/api-keys');
    const body = await createApiKey(db as unknown as D1Database, { workspaceId: m.workspace_id, userId: m.user_id, name: 'k' });
    const row = rows(db, 'SELECT workspace_id FROM api_keys')[0];
    expect(row.workspace_id).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(row.workspace_id).not.toBe('ws_default');

    const { resolveApiKey } = await import('../../src/auth/api-keys');
    expect(await resolveApiKey(db as unknown as D1Database, body.key)).toMatchObject({ workspaceId: row.workspace_id, role: 'owner' });
  });

  it('validates input', async () => {
    const env = makeEnv();
    const owner = await setupOwner(env);
    expect((await createKey(env, owner, {})).res.status).toBe(400);
    expect((await createKey(env, owner, { name: 'x', expires_in_days: -1 })).res.status).toBe(400);
    expect((await call(env, 'POST', '/api/keys', { body: { name: 'x' } })).status).toBe(401);
  });
});
