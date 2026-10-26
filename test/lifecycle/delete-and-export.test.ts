// Workspace delete revokes Cloudflare access; account deletion; ownership transfer; data export.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { world, type World } from '../connections/world';
import { delegatedKey } from '../auth/grant-fixture';
import { retryRevocations } from '../../src/lifecycle/revoke';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const ws = (id: string) => ({ 'x-workspace-id': id });

/** A has a second workspace (so deleting the first is allowed), and the first has no domains (no DNS to clean). */
async function readyToDelete(w: World) {
  w.db.sqlite.prepare('DELETE FROM domains WHERE workspace_id = ?').run(w.A.ws);
  const res = await w.api(w.A.token, 'POST', '/api/workspaces', { name: 'Second' });
  expect(res.status).toBe(201);
  return (await json(res)).id as string;
}

describe('deleting a workspace revokes its Cloudflare grants', () => {
  it('OAuth: the grant is revoked at Cloudflare before the rows go', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    await readyToDelete(w);
    const del = await w.api(w.A.token, 'DELETE', `/api/workspaces/${w.A.ws}`);
    expect(del.status).toBe(200);
    expect((await json(del)).cloudflare).toMatchObject({ connections: 1, revoked: 1, failed: 0 });
    expect(w.auth.revoked.map(r => r.hint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(w.rows('SELECT id FROM cloudflare_connections WHERE id = ?', id)).toEqual([]);
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.A.ws)).toEqual([]);
    expect(w.rows('SELECT * FROM revocation_tombstones')).toEqual([]);
  });

  it('a failed revoke does not stop the purge: it is logged and tombstoned, and the cron retries it', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    await readyToDelete(w);
    w.auth.revokeFails = true;
    const del = await w.api(w.A.token, 'DELETE', `/api/workspaces/${w.A.ws}`);
    expect(del.status).toBe(200);
    expect((await json(del)).cloudflare).toMatchObject({ connections: 1, revoked: 0, failed: 1 });
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.A.ws)).toEqual([]);
    expect(w.rows('SELECT id FROM cloudflare_connections WHERE id = ?', id)).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`connection ${id}`));
    const [t] = w.rows('SELECT * FROM revocation_tombstones');
    expect(t).toMatchObject({ deleted_workspace_id: w.A.ws, connection_id: id, attempts: 1 });
    expect(t.token_envelope).not.toContain('access-'); // still sealed

    // the next cron run, while Cloudflare is still failing: stays, attempts counted
    expect(await retryRevocations(w.env)).toEqual({ retried: 1, revoked: 0, dropped: 0 });
    expect(w.rows('SELECT attempts FROM revocation_tombstones')).toEqual([{ attempts: 2 }]);
    expect(w.auth.revoked).toEqual([]);

    // Cloudflare recovers: revoked, tombstone gone
    w.auth.revokeFails = false;
    expect(await retryRevocations(w.env)).toEqual({ retried: 1, revoked: 1, dropped: 0 });
    expect(w.auth.revoked.map(r => r.hint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(w.rows('SELECT * FROM revocation_tombstones')).toEqual([]);
  });

  it('keeps retrying for 30 days however many attempts, then gives up: drops the sealed token and records it in the audit log', async () => {
    const w = await world();
    const ins = w.db.sqlite.prepare("INSERT INTO revocation_tombstones (id, deleted_workspace_id, connection_id, token_envelope, attempts, created_at) VALUES (?, 'ws_gone', ?, 'junk', ?, ?)");
    const now = Math.floor(Date.now() / 1000);
    ins.run('t-many-attempts', 'c1', 50, now - 29 * 86400);
    ins.run('t-old', 'c2', 1, now - 31 * 86400);
    ins.run('t-fresh', 'c3', 1, now);
    expect(await retryRevocations(w.env)).toEqual({ retried: 2, revoked: 0, dropped: 1 });
    expect(w.rows('SELECT id FROM revocation_tombstones ORDER BY id')).toEqual([{ id: 't-fresh' }, { id: 't-many-attempts' }]);
    expect(w.rows("SELECT workspace_id, action, resource_id FROM audit_log WHERE action = 'cf_revocation.abandoned'")).toEqual([{ workspace_id: 'ws_gone', action: 'cf_revocation.abandoned', resource_id: 'c2' }]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('giving up revoking connection c2'));
  });

  it('a tombstone that cannot be written stops the delete: the connection, the workspace and its data stay', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    await readyToDelete(w);
    w.auth.revokeFails = true;
    w.db.sqlite.exec('DROP TABLE revocation_tombstones');
    const del = await w.api(w.A.token, 'DELETE', `/api/workspaces/${w.A.ws}`);
    expect(del.status).toBe(502);
    expect((await json(del)).code).toBe('revoke_failed');
    expect(w.rows('SELECT id FROM cloudflare_connections WHERE id = ?', id)).toHaveLength(1); // still there, still revocable
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.A.ws)).toHaveLength(1);
  });

  it('connections that cannot be listed stop the erase before anything is purged', async () => {
    const w = await world();
    const { eraseWorkspace } = await import('../../src/workspaces/routes');
    const tenant = {
      workspaceId: w.A.ws, db: w.db,
      scope: { connections: { list: async () => { throw new Error('D1 unavailable'); } }, team: { list: async () => [] } },
    } as any;
    const deps = { db: w.db, mode: 'saas', preflight: async () => null, tenantFor: async () => tenant, deleteDomain: async () => new Response(null, { status: 204 }) } as any;
    const res = await eraseWorkspace(deps, { waitUntil() {} } as any, tenant, [], { id: 'u' });
    expect(res.ok).toBe(false);
    expect((await (res as any).response.json()).code).toBe('revoke_failed');
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.A.ws)).toHaveLength(1);
    expect(w.rows('SELECT COUNT(*) n FROM memberships WHERE workspace_id = ?', w.A.ws)[0].n).toBeGreaterThan(0);
  });

  it('pasted tokens cannot be revoked remotely: counted so the owner is told, no tombstone', async () => {
    const w = await world();
    await w.addToken(w.A.token, 'pasted-secret-0123456789abc');
    await readyToDelete(w);
    const body = await json(await w.api(w.A.token, 'DELETE', `/api/workspaces/${w.A.ws}`));
    expect(body.cloudflare).toMatchObject({ connections: 1, pasted_tokens: 1, failed: 0 });
    expect(w.rows('SELECT * FROM revocation_tombstones')).toEqual([]);
  });
});

describe('DELETE /api/account', () => {
  it('needs the typed confirmation (the account email)', async () => {
    const w = await world();
    expect((await w.api(w.B.token, 'DELETE', '/api/account')).status).toBe(400);
    const wrong = await w.api(w.B.token, 'DELETE', '/api/account', { confirm: 'someone@else.com' });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).code).toBe('confirm_required');
    expect(w.rows("SELECT id FROM users WHERE email = 'b@example.com'")).toHaveLength(1);
  });

  it('refuses a sole owner whose workspace has other members, and names the workspace; nothing is deleted', async () => {
    const w = await world(); // A owns a workspace with an admin and a member
    const res = await w.api(w.A.token, 'DELETE', '/api/account', { confirm: 'A@Example.com' });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe('transfer_required');
    expect(body.workspaces).toMatchObject([{ id: w.A.ws, members: 3 }]);
    expect(w.rows("SELECT id FROM users WHERE email = 'a@example.com'")).toHaveLength(1);
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.A.ws)).toHaveLength(1);
  });

  it('after ownership is transferred, deletes the user and everything of theirs; the workspace stays', async () => {
    const w = await world();
    const adminId = w.rows("SELECT id FROM users WHERE email = 'admin@example.com'")[0].id;
    const aId = w.rows("SELECT id FROM users WHERE email = 'a@example.com'")[0].id;
    // A personal delegated credential, an audit entry with the email, an invite sent to them.
    const credential = await delegatedKey(w.db as any, { workspaceId: w.A.ws, userId: aId, name: 'personal', domain: 'a-corp.com' });
    w.db.sqlite.prepare("INSERT INTO invites (token, email, invited_by, expires_at, workspace_id) VALUES ('tok', 'a@example.com', ?, 9999999999, ?)").run(adminId, w.B.ws);
    expect(w.rows('SELECT COUNT(*) n FROM audit_log WHERE actor_email = ?', 'a@example.com')[0].n).toBeGreaterThan(0);

    const t = await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: adminId });
    expect(t.status).toBe(200);
    expect(w.rows('SELECT user_id, role FROM memberships WHERE workspace_id = ? AND role = ?', w.A.ws, 'owner')).toEqual([{ user_id: adminId, role: 'owner' }]);

    const res = await w.api(w.A.token, 'DELETE', '/api/account', { confirm: 'a@example.com' });
    expect(res.status).toBe(200);
    expect(w.rows('SELECT id FROM users WHERE id = ?', aId)).toEqual([]);
    for (const t of ['sessions', 'auth_accounts']) expect(w.rows(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, aId)[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) n FROM access_principals WHERE user_id = ?', aId)[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) n FROM access_credentials WHERE id = ?', credential.id)[0].n).toBe(0);
    expect((await w.api(credential.key, 'GET', '/api/resources')).status).toBe(401);
    expect(w.rows('SELECT COUNT(*) n FROM memberships WHERE user_id = ?', aId)[0].n).toBe(0);
    expect(w.rows("SELECT COUNT(*) n FROM invites WHERE email = 'a@example.com'")[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) n FROM audit_log WHERE actor_email = ?', 'a@example.com')[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) n FROM audit_log WHERE actor_id = ?', aId)[0].n).toBeGreaterThan(0); // the trail stays, pseudonymised
    // the workspace and its other members are untouched
    expect(w.rows('SELECT COUNT(*) n FROM memberships WHERE workspace_id = ?', w.A.ws)[0].n).toBe(2);
    expect(w.rows('SELECT COUNT(*) n FROM domains WHERE workspace_id = ?', w.A.ws)[0].n).toBe(2);
    // the old session no longer works
    expect((await w.api(w.A.token, 'GET', '/api/me')).status).toBe(401);
  });

  it('a workspace they alone belong to is deleted with them, and its Cloudflare grant revoked', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.B.token);
    const id = w.connectionId(res);
    w.db.sqlite.prepare('DELETE FROM domains WHERE workspace_id = ?').run(w.B.ws);
    const del = await w.api(w.B.token, 'DELETE', '/api/account', { confirm: 'b@example.com' });
    expect(del.status).toBe(200);
    const body = await json(del);
    expect(body.deleted_workspaces).toHaveLength(1);
    expect(w.auth.revoked.map(r => r.hint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(w.rows('SELECT id FROM cloudflare_connections WHERE id = ?', id)).toEqual([]);
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.B.ws)).toEqual([]);
    expect(w.rows("SELECT id FROM users WHERE email = 'b@example.com'")).toEqual([]);
  });

  it('a co-owner can delete their account; the workspace keeps its other owner', async () => {
    const w = await world();
    const adminId = w.rows("SELECT id FROM users WHERE email = 'admin@example.com'")[0].id;
    await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: adminId });
    // the new owner is the sole owner now, with members: blocked
    expect((await w.api(w.admin, 'DELETE', '/api/account', { confirm: 'admin@example.com' })).status).toBe(409);
    // the former owner (now an admin) can leave
    expect((await w.api(w.A.token, 'DELETE', '/api/account', { confirm: 'a@example.com' })).status).toBe(200);
  });

  it('pending invites they sent are revoked (used ones stay); connections they created are listed in the confirmation', async () => {
    const w = await world();
    const adminId = w.rows("SELECT id FROM users WHERE email = 'admin@example.com'")[0].id;
    const aId = w.rows("SELECT id FROM users WHERE email = 'a@example.com'")[0].id;
    await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: adminId });
    const ins = w.db.sqlite.prepare("INSERT INTO invites (token, email, invited_by, expires_at, used_at, workspace_id) VALUES (?, ?, 'a@example.com', 9999999999, ?, ?)");
    ins.run('pending-1', 'p1@x.com', null, w.A.ws);
    ins.run('accepted-1', 'p2@x.com', 123, w.A.ws);
    w.db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope, created_by, cf_account_name) VALUES ('cfc_a', ?, 'Lexgo CF', 'token', 'x', ?, 'Lexgo')").run(w.A.ws, aId);
    const preview = await json(await w.api(w.A.token, 'GET', '/api/account'));
    expect(preview).toMatchObject({ email: 'a@example.com', blocking: [], deleted_workspaces: [], connections_left_behind: [{ workspace: expect.any(String), label: 'Lexgo CF', cf_account_name: 'Lexgo' }] });
    const del = await w.api(w.A.token, 'DELETE', '/api/account', { confirm: 'a@example.com' });
    expect(del.status).toBe(200);
    expect((await json(del)).connections_left_behind).toBe(1);
    expect(w.rows("SELECT token FROM invites WHERE token IN ('pending-1','accepted-1')")).toEqual([{ token: 'accepted-1' }]);
    expect(w.rows("SELECT id FROM cloudflare_connections WHERE id = 'cfc_a'")).toHaveLength(1);
  });

  it('with several workspaces to erase, a failure on a later one names the ones already gone; the account stays', async () => {
    const w = await world();
    w.db.sqlite.prepare('DELETE FROM domains WHERE workspace_id = ?').run(w.B.ws);
    const second = (await json(await w.api(w.B.token, 'POST', '/api/workspaces', { name: 'Second' }))).id as string;
    // the second workspace has an OAuth connection whose revocation cannot be recorded
    w.db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope) VALUES ('cfc_b', ?, 'x', 'oauth', 'junk')").run(second);
    w.db.sqlite.exec('DROP TABLE revocation_tombstones');
    const res = await w.api(w.B.token, 'DELETE', '/api/account', { confirm: 'b@example.com' });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.already_deleted).toHaveLength(1);
    expect(body.error).toContain('Already deleted');
    expect(body.error).toContain('Your account was not deleted yet');
    expect(w.rows("SELECT id FROM users WHERE email = 'b@example.com'")).toHaveLength(1);
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', w.B.ws)).toEqual([]);
    expect(w.rows('SELECT id FROM workspaces WHERE id = ?', second)).toHaveLength(1);
  });

  it('scoped service credentials cannot delete accounts', async () => {
    const w = await world();
    const uid = w.rows("SELECT id FROM users WHERE email = 'b@example.com'")[0].id;
    const key = await delegatedKey(w.db as any, { workspaceId: w.B.ws, userId: uid, name: 'k', domain: 'b-corp.org', kind: 'service' });
    const raw = key.key;
    expect((await w.api(raw, 'GET', '/api/resources')).status).toBe(200);
    expect((await w.api(raw, 'DELETE', '/api/account', { confirm: 'b@example.com' })).status).toBe(403);
    expect(w.rows("SELECT id FROM users WHERE email = 'b@example.com'")).toHaveLength(1);
  });

  it('the self-host instance owner cannot delete the default workspace out from under everyone', async () => {
    const { createMigratedD1 } = await import('@inbox-angel/db/testing');
    const { call, makeEnv, setupOwner } = await import('../auth/helpers');
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const res = await call(env, 'DELETE', '/api/account', { key: owner, body: { confirm: 'owner@example.com' } });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('transfer_required');
  });
});

describe('POST /api/workspaces/:id/transfer-ownership', () => {
  it('owner only, to a member of that workspace; the previous owner becomes an admin', async () => {
    const w = await world();
    const memberId = w.rows("SELECT id FROM users WHERE email = 'member@example.com'")[0].id;
    const bId = w.rows("SELECT id FROM users WHERE email = 'b@example.com'")[0].id;
    expect((await w.api(w.admin, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: memberId })).status).toBe(403);
    expect((await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: bId })).status).toBe(404); // not a member
    expect((await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, {})).status).toBe(400);
    expect((await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: 'nobody' })).status).toBe(404);
    expect((await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: memberId })).status).toBe(200);
    const roles = Object.fromEntries(w.rows('SELECT u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', w.A.ws).map(r => [r.email, r.role]));
    expect(roles).toMatchObject({ 'a@example.com': 'admin', 'member@example.com': 'owner' });
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'workspace.ownership_transferred'")).toHaveLength(1);
    // the old owner can no longer transfer
    expect((await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: memberId })).status).toBe(403);
  });
});

describe('GET /api/workspaces/:id/export', () => {
  it('an owner gets everything the workspace holds, as JSON, without secrets', async () => {
    const w = await world();
    const s = w.db.sqlite;
    s.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, raw_xml, workspace_id) VALUES (1, 1, 'google.com', 'r1', 1, 2, '<raw-xml/>', ?)").run(w.A.ws);
    s.prepare("INSERT INTO report_records (report_id, source_ip, disposition, workspace_id) VALUES (1, '1.2.3.4', 'none', ?)").run(w.A.ws);
    s.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'turnstile_secret_key', 'SECRET-VALUE')").run(w.A.ws);
    await w.addToken(w.A.token, 'pasted-secret-0123456789abc');

    const res = await w.api(w.A.token, 'GET', `/api/workspaces/${w.A.ws}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.workspace.id).toBe(w.A.ws);
    expect(data.members.map((m: any) => m.email).sort()).toEqual(['a@example.com', 'admin@example.com', 'member@example.com']);
    expect(data.domains.map((d: any) => d.domain).sort()).toEqual(['a-corp.com', 'a-two.org']);
    expect(data.aggregate_reports).toMatchObject([{ report_id: 'r1' }]);
    expect(data.report_records).toMatchObject([{ source_ip: '1.2.3.4' }]);
    expect(data.cloudflare_connections).toHaveLength(1);
    expect(data.audit_log.length).toBeGreaterThan(0);
    // none of the secrets, none of the other workspace's data
    for (const secret of ['SECRET-VALUE', 'pasted-secret-0123456789abc', '<raw-xml/>', 'password_hash', 'token_envelope', 'key_hash', 'b-corp.org', 'b@example.com']) expect(text).not.toContain(secret);
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'workspace.exported'")).toHaveLength(1);
  });

  it('too large for one invocation: 413 with a clear message, nothing streamed', async () => {
    const w = await world();
    const { streamWorkspaceExport } = await import('../../src/lifecycle/export');
    const res = await streamWorkspaceExport(w.db as any, w.A.ws, 'a@example.com', 1);
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.code).toBe('export_too_large');
    expect(body.error).toContain('too large to export in one request');
  });

  it('a failure part-way errors the stream instead of closing it as if complete', async () => {
    const w = await world();
    const { exportStream } = await import('../../src/lifecycle/export');
    const prepare = w.db.prepare.bind(w.db);
    (w.db as any).prepare = (sql: string) => { if (/FROM tls_reports/.test(sql)) throw new Error('D1 went away'); return prepare(sql); };
    const reader = exportStream(w.db as any, w.A.ws, 'a@example.com').getReader();
    let got = '';
    const dec = new TextDecoder();
    await expect((async () => { for (;;) { const r = await reader.read(); if (r.done) return; got += dec.decode(r.value); } })()).rejects.toThrow('D1 went away');
    expect(got.startsWith('{"exported_at"')).toBe(true);
    expect(got.endsWith('}')).toBe(false);
  });

  it('is pull-based: nothing is read until the client asks', async () => {
    const w = await world();
    const { exportStream } = await import('../../src/lifecycle/export');
    let queries = 0;
    const prepare = w.db.prepare.bind(w.db);
    (w.db as any).prepare = (sql: string) => { queries++; return prepare(sql); };
    const stream = exportStream(w.db as any, w.A.ws, 'a@example.com');
    await new Promise((r) => setTimeout(r, 20));
    expect(queries).toBe(0);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(queries).toBeLessThan(3);
  });

  it('pages through big tables', async () => {
    const w = await world();
    const ins = w.db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, workspace_id) VALUES (?, 1, 'g', ?, 1, 2, ?)");
    for (let i = 1; i <= 2500; i++) ins.run(i, `r${i}`, w.A.ws);
    const data = await json(await w.api(w.A.token, 'GET', `/api/workspaces/${w.A.ws}/export`));
    expect(data.aggregate_reports).toHaveLength(2500);
    expect(data.aggregate_reports.at(-1).report_id).toBe('r2500');
  });

  it('owners only; other workspaces answer 404', async () => {
    const w = await world();
    expect((await w.api(w.admin, 'GET', `/api/workspaces/${w.A.ws}/export`)).status).toBe(403);
    expect((await w.api(w.member, 'GET', `/api/workspaces/${w.A.ws}/export`)).status).toBe(403);
    expect((await w.api(w.B.token, 'GET', `/api/workspaces/${w.A.ws}/export`)).status).toBe(404);
  });
});
void ws;

describe('transferOwnership (one batch)', () => {
  it('a stale request (the caller is no longer an owner, or the target is no member) changes nothing and never leaves the workspace ownerless', async () => {
    const w = await world();
    const { workspaceLifecycle } = await import('@inbox-angel/db');
    const life = workspaceLifecycle(w.db as any);
    const id = (email: string) => w.rows('SELECT id FROM users WHERE email = ?', email)[0].id as string;
    const roles = () => Object.fromEntries(w.rows('SELECT u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', w.A.ws).map(r => [r.email, r.role]));
    const before = roles();
    expect(await life.transferOwnership(w.A.ws, id('admin@example.com'), id('member@example.com'))).toBe(false); // admin is not an owner
    expect(await life.transferOwnership(w.A.ws, id('a@example.com'), id('b@example.com'))).toBe(false); // b is not a member
    expect(roles()).toEqual(before);
    expect(await life.transferOwnership(w.A.ws, id('a@example.com'), id('member@example.com'))).toBe(true);
    expect(roles()).toMatchObject({ 'a@example.com': 'admin', 'member@example.com': 'owner' });
  });
});
