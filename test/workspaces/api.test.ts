// /api/workspaces: list, create, rename, leave, delete — and what switching between workspaces does to what a user sees.
import { describe, it, expect, vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
const json = async (res: Response) => (await res.json()) as any;
const ws = (id: string) => ({ 'x-workspace-id': id });

async function selfHost() {
  const db = createMigratedD1();
  const env = makeEnv(db);
  const owner = await setupOwner(env);
  return { db, env, owner };
}

async function create(env: any, key: string, name: string) {
  const res = await call(env, 'POST', '/api/workspaces', { key, body: { name } });
  expect(res.status).toBe(201);
  return (await json(res)).id as string;
}

/** A workspace owned by an existing user, made behind the API's back (self-host: only the instance owner may create them). */
function grant(db: any, email: string, name: string) {
	const id = `ws_${name.toLowerCase().replace(/\W/g, '')}`;
	db.sqlite.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(id, name);
	db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, (SELECT id FROM users WHERE email = ?), 'owner')").run(id, email);
	return id;
}

const addDomain = (db: any, workspaceId: string, domain: string) =>
  db.sqlite.prepare('INSERT INTO domains (domain, rua_address, workspace_id) VALUES (?, ?, ?)').run(domain, `rua@reports.${domain}`, workspaceId);

describe('GET/POST /api/workspaces', () => {
  it('lists the caller’s workspaces with role and member count; creating one makes the caller its owner (self-host too)', async () => {
    const { env, owner, db } = await selfHost();
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const first = await json(await call(env, 'GET', '/api/workspaces', { key: owner }));
    expect(first.workspaces).toMatchObject([{ id: 'ws_default', role: 'owner', member_count: 2 }]);

    const lexgo = await create(env, owner, '  Lexgo  ');
    expect(lexgo).toMatch(/^ws_[0-9a-f]{32}$/);
    const list = await json(await call(env, 'GET', '/api/workspaces', { key: owner }));
    expect(list.workspaces).toMatchObject([
      { id: 'ws_default', role: 'owner', member_count: 2 },
      { id: lexgo, name: 'Lexgo', role: 'owner', member_count: 1 },
    ]);
    // the member is read-only in ws_default and sees only the workspaces they belong to (not Lexgo)
    expect((await json(await call(env, 'GET', '/api/workspaces', { key: member }))).workspaces.map((w: any) => [w.id, w.role])).toEqual([['ws_default', 'member']]);
    expect(rows(db, 'SELECT action FROM audit_log WHERE workspace_id = ?', lexgo)).toEqual([{ action: 'workspace.created' }]);
  });

  it('self-host: only the instance owner (owner of ws_default) creates workspaces; admins and members get 403', async () => {
    const { env, owner, db } = await selfHost();
    const admin = await inviteAndAccept(env, owner, 'a@example.com', 'admin');
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    for (const key of [admin, member]) {
      const res = await call(env, 'POST', '/api/workspaces', { key, body: { name: 'Mine' } });
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe('instance_owner_required');
    }
    expect(rows(db, 'SELECT COUNT(*) n FROM workspaces')).toEqual([{ n: 1 }]);
    // someone who owns some *other* workspace (made some other way) is still not the instance owner
    grant(db, 'm@example.com', 'Elsewhere');
    expect((await call(env, 'POST', '/api/workspaces', { key: member, body: { name: 'Mine' } })).status).toBe(403);
    expect((await call(env, 'POST', '/api/workspaces', { key: owner, body: { name: 'Lexgo' } })).status).toBe(201);
  });

  it('validates the name', async () => {
    const { env, owner } = await selfHost();
    for (const name of ['', '   ', 'x'.repeat(81), 7 as any]) {
      expect((await call(env, 'POST', '/api/workspaces', { key: owner, body: { name } })).status, String(name)).toBe(400);
    }
    expect((await call(env, 'POST', '/api/workspaces', { key: owner, body: {} })).status).toBe(400);
  });

  it('works in saas mode too, and a user is not placed in anyone else’s workspace', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, HOSTED_ENV);
    const signup = async (email: string) => (await json(await call(env, 'POST', '/api/auth/signup', { body: { name: email, email, password: 'password-123' } }))).token as string;
    const a = await signup('a@example.com');
    const b = await signup('b@example.com');
    const second = await create(env, a, 'Second');
    expect((await json(await call(env, 'GET', '/api/workspaces', { key: a }))).workspaces).toHaveLength(2);
    expect((await json(await call(env, 'GET', '/api/workspaces', { key: b }))).workspaces).toHaveLength(1);
    expect((await call(env, 'PATCH', `/api/workspaces/${second}`, { key: b, body: { name: 'x' } })).status).toBe(404);
  });

  it('is for signed-in users only: no credential → 401; API keys and the instance key → 403', async () => {
    const { env, owner, db } = await selfHost();
    expect((await call(env, 'GET', '/api/workspaces')).status).toBe(401);
    const { createApiKey } = await import('../../src/auth/api-keys');
    const uid = rows(db, 'SELECT id FROM users')[0].id;
    const k = await createApiKey(db as any, { workspaceId: 'ws_default', userId: uid, name: 'k' });
    expect((await call(env, 'GET', '/api/workspaces', { key: k.key })).status).toBe(403);
    expect((await call(env, 'POST', '/api/workspaces', { key: k.key, body: { name: 'x' } })).status).toBe(403);
    const withInstanceKey = makeEnv(db, { API_KEY: 'instance-key-0123456789' });
    expect((await call(withInstanceKey, 'GET', '/api/workspaces', { key: 'instance-key-0123456789' })).status).toBe(403);
    expect(owner).toBeTruthy();
  });

  it('still lists a user’s workspaces when X-Workspace-Id names one they have left', async () => {
    const { env, owner } = await selfHost();
    const lexgo = await create(env, owner, 'Lexgo');
    const gone = 'ws_00000000000000000000000000000000';
    expect((await call(env, 'GET', '/api/domains', { key: owner, headers: ws(gone) })).status).toBe(403);
    const res = await call(env, 'GET', '/api/workspaces', { key: owner, headers: ws(gone) });
    expect(res.status).toBe(200);
    expect((await json(res)).workspaces.map((w: any) => w.id)).toContain(lexgo);
  });
});

describe('rename', () => {
  it('only an owner may rename; non-members get 404', async () => {
    const { env, owner, db } = await selfHost();
    const admin = await inviteAndAccept(env, owner, 'a@example.com', 'admin');
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const stranger = grant(db, 'm@example.com', 'Elsewhere'); // member's own workspace, unrelated to ws_default
    expect((await call(env, 'PATCH', '/api/workspaces/ws_default', { key: member, body: { name: 'x' } })).status).toBe(403);
    expect((await call(env, 'PATCH', '/api/workspaces/ws_default', { key: admin, body: { name: 'x' } })).status).toBe(403);
    expect((await call(env, 'PATCH', `/api/workspaces/${stranger}`, { key: admin, body: { name: 'x' } })).status).toBe(404);
    expect((await call(env, 'PATCH', '/api/workspaces/ws_default', { key: owner, body: { name: '' } })).status).toBe(400);
    const ok = await call(env, 'PATCH', '/api/workspaces/ws_default', { key: owner, body: { name: 'Fellowship' } });
    expect(ok.status).toBe(200);
    expect((await json(await call(env, 'GET', '/api/workspaces', { key: owner }))).workspaces[0].name).toBe('Fellowship');
  });
});

describe('leave', () => {
  it('a member leaves their workspace; the last owner cannot; nobody leaves their only workspace', async () => {
    const { env, owner, db } = await selfHost();
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const lexgo = await create(env, owner, 'Lexgo');

    // the owner is the only owner of both
    const last = await call(env, 'POST', `/api/workspaces/${lexgo}/leave`, { key: owner, body: {} });
    expect(last.status).toBe(409);
    expect((await json(last)).code).toBe('last_owner');

    // the member's only workspace
    const only = await call(env, 'POST', '/api/workspaces/ws_default/leave', { key: member, body: {} });
    expect(only.status).toBe(409);
    expect((await json(only)).code).toBe('only_workspace');

    // once they have another one, leaving works and keeps their login
    grant(db, 'm@example.com', 'Mine');
    expect((await call(env, 'POST', '/api/workspaces/ws_default/leave', { key: member, body: {} })).status).toBe(200);
    expect(rows(db, "SELECT COUNT(*) n FROM memberships WHERE workspace_id = 'ws_default'")).toEqual([{ n: 1 }]);
    expect(rows(db, "SELECT COUNT(*) n FROM users WHERE email = 'm@example.com'")).toEqual([{ n: 1 }]);
    // and the workspace they left is no longer reachable
    expect((await call(env, 'GET', '/api/domains', { key: member, headers: ws('ws_default') })).status).toBe(403);
    expect((await call(env, 'POST', '/api/workspaces/ws_default/leave', { key: member, body: {} })).status).toBe(404);
  });

  it('an owner may leave once another owner exists', async () => {
    const { env, owner, db } = await selfHost();
    await create(env, owner, 'Spare'); // so ws_default is not the owner's only workspace
    const admin = await inviteAndAccept(env, owner, 'a@example.com', 'admin');
    expect((await call(env, 'POST', '/api/workspaces/ws_default/leave', { key: owner, body: {} })).status).toBe(409);
    db.sqlite.prepare("UPDATE memberships SET role = 'owner' WHERE user_id = (SELECT id FROM users WHERE email = 'a@example.com') AND workspace_id = 'ws_default'").run();
    expect((await call(env, 'POST', '/api/workspaces/ws_default/leave', { key: owner, body: {} })).status).toBe(200);
    expect((await call(env, 'GET', '/api/me', { key: admin })).status).toBe(200);
  });
});

describe('delete', () => {
  it('owners only; never the default workspace; never your only workspace', async () => {
    const { env, owner, db } = await selfHost();
    const admin = await inviteAndAccept(env, owner, 'a@example.com', 'admin');
    expect((await call(env, 'DELETE', '/api/workspaces/ws_default', { key: admin })).status).toBe(403);
    expect((await json(await call(env, 'DELETE', '/api/workspaces/ws_default', { key: owner }))).code).toBe('default_workspace');
    const lexgo = await create(env, owner, 'Lexgo');
    // not a member → 404
    expect((await call(env, 'DELETE', `/api/workspaces/${lexgo}`, { key: admin })).status).toBe(404);
    const solo = grant(db, 'a@example.com', 'Solo');
    expect((await call(env, 'DELETE', `/api/workspaces/${solo}`, { key: admin })).status).toBe(200); // admin still has ws_default
    const only = await json(await call(env, 'DELETE', `/api/workspaces/${lexgo}`, { key: owner }));
    expect(only).toEqual({ ok: true }); // owner has ws_default too
  });

  it('an empty workspace goes at once; one with domains needs the name repeated, then takes its data with it', async () => {
    const { env, owner, db } = await selfHost();
    const empty = await create(env, owner, 'Empty');
    expect((await call(env, 'DELETE', `/api/workspaces/${empty}`, { key: owner })).status).toBe(200);
    expect(rows(db, 'SELECT id FROM workspaces WHERE id = ?', empty)).toEqual([]);

    const lexgo = await create(env, owner, 'Lexgo');
    addDomain(db, lexgo, 'lexgo.example.com');
    addDomain(db, 'ws_default', 'fellowship.example.com');
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'brand_color', '#fff')").run(lexgo);
    db.sqlite.prepare("INSERT INTO invites (token, email, role, invited_by, expires_at, workspace_id) VALUES ('t', 'x@y.z', 'member', 'o', 9999999999, ?)").run(lexgo);

    const refused = await call(env, 'DELETE', `/api/workspaces/${lexgo}`, { key: owner });
    expect(refused.status).toBe(409);
    expect((await json(refused)).code).toBe('confirm_required');
    expect((await call(env, 'DELETE', `/api/workspaces/${lexgo}?confirm=nope`, { key: owner })).status).toBe(409);
    expect(rows(db, 'SELECT COUNT(*) n FROM domains WHERE workspace_id = ?', lexgo)).toEqual([{ n: 1 }]);

    expect((await call(env, 'DELETE', `/api/workspaces/${lexgo}?confirm=Lexgo`, { key: owner })).status).toBe(200);
    for (const t of ['domains', 'settings', 'invites', 'memberships']) {
      expect(rows(db, `SELECT COUNT(*) n FROM ${t} WHERE workspace_id = ?`, lexgo), t).toEqual([{ n: 0 }]);
    }
    expect(rows(db, 'SELECT id FROM workspaces WHERE id = ?', lexgo)).toEqual([]);
    // the other workspace is untouched
    expect(rows(db, "SELECT domain FROM domains WHERE workspace_id = 'ws_default'")).toEqual([{ domain: 'fellowship.example.com' }]);
  });

  it('people who belonged only to the deleted workspace are removed; people with another workspace keep their login', async () => {
    const { env, owner, db } = await selfHost();
    const lexgo = await create(env, owner, 'Lexgo');
    const inv = await json(await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws(lexgo), body: { email: 'only@lexgo.test', role: 'member' } }));
    await call(env, 'POST', `/api/invites/${inv.token}`, { body: { name: 'Only', password: 'password-123' } });
    expect(rows(db, "SELECT COUNT(*) n FROM users WHERE email = 'only@lexgo.test'")).toEqual([{ n: 1 }]);
    expect((await call(env, 'DELETE', `/api/workspaces/${lexgo}`, { key: owner })).status).toBe(200);
    expect(rows(db, "SELECT COUNT(*) n FROM users WHERE email = 'only@lexgo.test'")).toEqual([{ n: 0 }]);
    expect(rows(db, "SELECT COUNT(*) n FROM users WHERE email = 'owner@example.com'")).toEqual([{ n: 1 }]);
  });
});

describe('selection: X-Workspace-Id', () => {
  it('a user in two workspaces sees only the selected one; switching never leaks; no header = oldest membership', async () => {
    const { env, owner, db } = await selfHost();
    const lexgo = await create(env, owner, 'Lexgo');
    addDomain(db, 'ws_default', 'fellowship.example.com');
    addDomain(db, lexgo, 'lexgo-one.example.com');
    addDomain(db, lexgo, 'lexgo-two.example.com');
    const domains = async (id?: string) => (await json(await call(env, 'GET', '/api/domains', { key: owner, headers: id ? ws(id) : {} }))).domains.map((d: any) => d.domain);

    expect(await domains()).toEqual(['fellowship.example.com']);
    expect(await domains(lexgo)).toEqual(['lexgo-one.example.com', 'lexgo-two.example.com']);
    expect(await domains('ws_default')).toEqual(['fellowship.example.com']);
    for (const id of [lexgo, 'ws_default']) {
      const me = await json(await call(env, 'GET', '/api/me', { key: owner, headers: ws(id) }));
      expect(me.workspace_id).toBe(id);
      const other = id === lexgo ? 'fellowship' : 'lexgo';
      for (const path of ['/api/domains', '/api/reports', '/api/audit-log', '/api/team', '/api/analytics?days=30']) {
        expect(JSON.stringify(await json(await call(env, 'GET', path, { key: owner, headers: ws(id) }))), `${id} ${path}`).not.toContain(other);
      }
    }
    // a workspace the user is not in is refused, not silently replaced
    const foreign = await selfHostOther(env, db);
    expect((await call(env, 'GET', '/api/domains', { key: owner, headers: ws(foreign) })).status).toBe(403);
  });

  it('writes land in the selected workspace', async () => {
    const { env, owner, db } = await selfHost();
    const lexgo = await create(env, owner, 'Lexgo');
    const res = await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws(lexgo), body: { email: 'c@lexgo.test' } });
    expect(res.status).toBe(201);
    expect(rows(db, "SELECT workspace_id FROM invites WHERE email = 'c@lexgo.test'")).toEqual([{ workspace_id: lexgo }]);
    expect((await json(await call(env, 'GET', '/api/team', { key: owner, headers: ws(lexgo) }))).users.map((u: any) => u.email)).toEqual(['owner@example.com']);
  });

  it('roles are per workspace: owner in one, read-only member in the other', async () => {
    const { env, owner, db } = await selfHost();
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const mine = grant(db, 'm@example.com', 'Mine');
    addDomain(db, 'ws_default', 'fellowship.example.com');
    expect((await json(await call(env, 'GET', '/api/me', { key: member, headers: ws('ws_default') }))).role).toBe('member');
    expect((await json(await call(env, 'GET', '/api/me', { key: member, headers: ws(mine) }))).role).toBe('owner');
    expect((await call(env, 'DELETE', '/api/domains/1', { key: member, headers: ws('ws_default') })).status).toBe(403);
    expect((await call(env, 'POST', '/api/team/invite', { key: member, headers: ws(mine), body: { email: 'x@y.test' } })).status).toBe(201);
  });
});

/** A workspace owned by someone else entirely. */
async function selfHostOther(_env: any, db: any) {
  db.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_foreign', 'Foreign')").run();
  return 'ws_foreign';
}
