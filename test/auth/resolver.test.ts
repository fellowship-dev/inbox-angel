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
import { call, ctx, makeEnv, setupOwner, inviteAndAccept, req, signupVerified } from './helpers';
import { sessionWorkspaceResolver } from '../../src/auth/resolver';
import { delegatedKey } from './grant-fixture';

const rows = (db: { sqlite: any }, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
const ask = (env: Env, key?: string, headers: Record<string, string> = {}) =>
  sessionWorkspaceResolver(req('GET', '/api/access', { key, headers }), env);

describe('WorkspaceResolver: session → user → membership → workspace', () => {
  it('maps a session to its workspace, user and role', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const ownerId = rows(db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    const memberId = rows(db, "SELECT id FROM users WHERE email = 'm@example.com'")[0].id;

    expect(await ask(env, owner)).toMatchObject({ workspaceId: 'ws_default', userId: ownerId, role: 'owner', kind: 'session' });
    expect(await ask(env, member)).toMatchObject({ workspaceId: 'ws_default', userId: memberId, role: 'member' });
  });

  it('saas: each signup resolves to its own workspace', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    const tok = (e: string) => signupVerified(env, e);
    const [a, b] = [await tok('a@example.com'), await tok('b@example.com')];
    const [ra, rb] = [await ask(env, a), await ask(env, b)];
    expect(ra!.workspaceId).not.toBe(rb!.workspaceId);
    expect(ra).toMatchObject({ role: 'owner' });
    expect(rows(db, 'SELECT workspace_id FROM memberships WHERE user_id = ?', ra!.userId)).toEqual([{ workspace_id: ra!.workspaceId }]);
  });

  it('a user in several workspaces picks one with X-Workspace-Id, and cannot pick one they are not in', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    const a = await signupVerified(env, 'a@example.com');
    const b = await signupVerified(env, 'b@example.com');
    const [accA, accB] = [(await ask(env, a))!.workspaceId, (await ask(env, b))!.workspaceId];
    const userA = (await ask(env, a))!.userId!;
    db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', unixepoch() + 100)").run(accB, userA);

    expect((await ask(env, a))!.workspaceId).toBe(accA); // oldest membership by default
    expect(await ask(env, a, { 'x-workspace-id': accB })).toMatchObject({ workspaceId: accB, role: 'member' });
    await expect(ask(env, b, { 'x-workspace-id': accA })).rejects.toThrow(/not a member/); // b is not in a's workspace (403)
  });

  it('finite delegated keys resolve identity and retired instance credentials resolve to null', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { API_KEY: 'instance-secret-key' });
    const owner = await setupOwner(env);
    const userId = rows(db, 'SELECT id FROM users')[0].id;
    const { key } = await delegatedKey(db as unknown as D1Database, { workspaceId: 'ws_default', userId, name: 'k', domain: 'example.com' });

    expect(await ask(env, key)).toMatchObject({ workspaceId: 'ws_default', userId, role: 'owner', kind: 'api_key' });
    expect(await ask(env, 'instance-secret-key')).toBeNull();
    expect(await ask(env)).toBeNull();
    expect(await ask(env, 'nonsense')).toBeNull();
    expect(owner).toBeTruthy();
  });

  it('a signed-in user with no membership is refused (403), not given a workspace', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    db.sqlite.prepare('DELETE FROM memberships').run();
    await expect(ask(env, owner)).rejects.toThrow(/not a member/);
    expect((await call(env, 'GET', '/api/domains', { key: owner })).status).toBe(403);
  });
});

