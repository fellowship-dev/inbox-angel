// Invites when the email already has a login: accepting adds a membership, never a second user.
import { describe, it, expect, vi } from 'vitest';
import { delegatedKey } from '../auth/grant-fixture';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept } from '../auth/helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
const json = async (res: Response) => (await res.json()) as any;
const ws = (id: string) => ({ 'x-workspace-id': id });
const PASSWORD = 'invitee-password-1';

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db);
  const owner = await setupOwner(env); // Max, owner of ws_default (Fellowship)
  const lexgo = (await json(await call(env, 'POST', '/api/workspaces', { key: owner, body: { name: 'Lexgo' } }))).id as string;
  const invite = async (email: string, role = 'member') => (await json(await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws(lexgo), body: { email, role } }))).token as string;
  const login = async (email: string) => (await json(await call(env, 'POST', '/api/auth/login', { body: { email, password: PASSWORD } }))).token as string;
  return { db, env, owner, lexgo, invite, login };
}

describe('invite to an email that already has a login', () => {
  it('the invite can be sent; inviting someone who is already a member is refused', async () => {
    const { env, owner, lexgo, invite } = await world();
    await inviteAndAccept(env, owner, 'sam@example.com', 'member'); // Sam exists, in Fellowship
    expect(await invite('sam@example.com')).toBeTruthy();
    const dup = await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws('ws_default'), body: { email: 'sam@example.com' } });
    expect(dup.status).toBe(409);
    expect(lexgo).toBeTruthy();
  });

  it('GET tells the page whether the email has a login and who is signed in', async () => {
    const { env, owner, invite, login } = await world();
    const sam = await inviteAndAccept(env, owner, 'sam@example.com', 'member');
    const t = await invite('sam@example.com');
    const anon = await json(await call(env, 'GET', `/api/invites/${t}`));
    expect(anon).toMatchObject({ email: 'sam@example.com', role: 'member', workspace_name: 'Lexgo', user_exists: true, signed_in_as: null });
    const asSam = await json(await call(env, 'GET', `/api/invites/${t}`, { key: sam }));
    expect(asSam.signed_in_as).toBe('sam@example.com');
    const asOwner = await json(await call(env, 'GET', `/api/invites/${t}`, { key: owner }));
    expect(asOwner.signed_in_as).toBe('owner@example.com');
    const fresh = await invite('new@lexgo.test');
    expect(await json(await call(env, 'GET', `/api/invites/${fresh}`))).toMatchObject({ user_exists: false });
    expect(await login('sam@example.com')).toBeTruthy();
  });

  it('signed in as that email: one click adds the membership, with no new user, and the invite is spent', async () => {
    const { db, env, owner, lexgo, invite } = await world();
    const sam = await inviteAndAccept(env, owner, 'sam@example.com', 'member');
    const t = await invite('sam@example.com', 'admin');
    const usersBefore = rows(db, 'SELECT COUNT(*) n FROM users')[0].n;

    const res = await call(env, 'POST', `/api/invites/${t}`, { key: sam, body: {} });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, workspace_id: lexgo, workspace_name: 'Lexgo' });
    expect(rows(db, 'SELECT COUNT(*) n FROM users')[0].n).toBe(usersBefore);
    expect(rows(db, "SELECT workspace_id, role FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = 'sam@example.com') ORDER BY workspace_id")
      .sort((a, b) => a.workspace_id.localeCompare(b.workspace_id))).toEqual([{ workspace_id: 'ws_default', role: 'member' }, { workspace_id: lexgo, role: 'admin' }].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)));
    expect(rows(db, 'SELECT used_at FROM invites WHERE token = ?', t)[0].used_at).not.toBeNull();
    // Sam now sees Lexgo, with the invited role, and keeps Fellowship read-only
    expect((await json(await call(env, 'GET', '/api/me', { key: sam, headers: ws(lexgo) }))).role).toBe('admin');
    expect((await json(await call(env, 'GET', '/api/me', { key: sam, headers: ws('ws_default') }))).role).toBe('member');
    expect(rows(db, "SELECT action FROM audit_log WHERE workspace_id = ? AND action = 'auth.invite_accepted'", lexgo)).toHaveLength(1);
    // the link is single-use
    expect((await call(env, 'POST', `/api/invites/${t}`, { key: sam, body: {} })).status).toBe(404);
  });

  it('signed in as a different email: a clear refusal, and nothing changes', async () => {
    const { db, env, owner, invite } = await world();
    await inviteAndAccept(env, owner, 'sam@example.com', 'member');
    const t = await invite('sam@example.com');
    const res = await call(env, 'POST', `/api/invites/${t}`, { key: owner, body: {} });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe('wrong_user');
    expect(body.error).toContain('sam@example.com');
    expect(body.error).toContain('owner@example.com');
    expect(rows(db, 'SELECT used_at FROM invites WHERE token = ?', t)[0].used_at).toBeNull();
    expect(rows(db, "SELECT COUNT(*) n FROM memberships WHERE role = 'member' AND user_id = (SELECT id FROM users WHERE email = 'owner@example.com')")[0].n).toBe(0);
  });

  it('not signed in: asked to sign in (401), and a password is never used to take over the existing login', async () => {
    const { db, env, owner, invite } = await world();
    await inviteAndAccept(env, owner, 'sam@example.com', 'member');
    const t = await invite('sam@example.com');
    const res = await call(env, 'POST', `/api/invites/${t}`, { body: { name: 'Mallory', password: 'mallory-password-1' } });
    expect(res.status).toBe(401);
    expect(rows(db, 'SELECT used_at FROM invites WHERE token = ?', t)[0].used_at).toBeNull();
    expect(rows(db, "SELECT COUNT(*) n FROM users WHERE email = 'sam@example.com'")[0].n).toBe(1);
  });

  it('a service credential cannot accept a human invitation', async () => {
    const { db, env, owner, invite } = await world();
    await inviteAndAccept(env, owner, 'sam@example.com', 'member');
    const t = await invite('sam@example.com');
    const uid = rows(db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    const k = await delegatedKey(db as any, { workspaceId: 'ws_default', userId: uid, name: 'k', domain: 'example.com', kind: 'service' });
    expect((await call(env, 'GET', '/api/resources', { key: k.key })).status).toBe(200);
    expect((await call(env, 'POST', `/api/invites/${t}`, { key: k.key, body: {} })).status).toBe(401);
    expect(rows(db, 'SELECT used_at FROM invites WHERE token = ?', t)[0].used_at).toBeNull();
  });

  it('expired or unknown invites are 404 for existing users too', async () => {
    const { db, env, owner, invite } = await world();
    const sam = await inviteAndAccept(env, owner, 'sam@example.com', 'member');
    const t = await invite('sam@example.com');
    db.sqlite.prepare('UPDATE invites SET expires_at = 1 WHERE token = ?').run(t);
    expect((await call(env, 'POST', `/api/invites/${t}`, { key: sam, body: {} })).status).toBe(404);
    expect((await call(env, 'POST', '/api/invites/nope', { key: sam, body: {} })).status).toBe(404);
  });
});

describe('invite to an email with no login (today’s flow)', () => {
  it('creates the user with a password and the membership, and signs them in', async () => {
    const { db, env, lexgo, invite } = await world();
    const t = await invite('new@lexgo.test');
    const res = await call(env, 'POST', `/api/invites/${t}`, { body: { name: 'New', password: PASSWORD } });
    expect(res.status).toBe(201);
    const { token } = await json(res);
    expect(rows(db, "SELECT workspace_id, role FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = 'new@lexgo.test')")).toEqual([{ workspace_id: lexgo, role: 'member' }]);
    // they see only Lexgo, read-only
    const list = await json(await call(env, 'GET', '/api/workspaces', { key: token }));
    expect(list.workspaces.map((w: any) => [w.id, w.role])).toEqual([[lexgo, 'member']]);
    expect((await json(await call(env, 'GET', '/api/me', { key: token }))).workspace_id).toBe(lexgo);
    expect((await call(env, 'GET', '/api/domains', { key: token, headers: ws('ws_default') })).status).toBe(403);
  });

  it('still needs a name and a password', async () => {
    const { env, invite } = await world();
    const t = await invite('new@lexgo.test');
    expect((await call(env, 'POST', `/api/invites/${t}`, { body: {} })).status).toBe(400);
    expect((await call(env, 'POST', `/api/invites/${t}`, { body: { name: 'x', password: 'short' } })).status).toBe(400);
  });
});
