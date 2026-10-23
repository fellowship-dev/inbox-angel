// Workspace delete revokes Cloudflare access; account deletion; ownership transfer; data export.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { world, type World } from '../connections/world';
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

  it('gives up after too many attempts or 30 days, and drops the sealed token', async () => {
    const w = await world();
    const ins = w.db.sqlite.prepare("INSERT INTO revocation_tombstones (id, deleted_workspace_id, connection_id, token_envelope, attempts, created_at) VALUES (?, 'ws_gone', ?, 'junk', ?, ?)");
    const now = Math.floor(Date.now() / 1000);
    ins.run('t-attempts', 'c1', 10, now);
    ins.run('t-old', 'c2', 1, now - 31 * 86400);
    ins.run('t-fresh', 'c3', 1, now);
    expect(await retryRevocations(w.env)).toEqual({ retried: 1, revoked: 0, dropped: 2 });
    expect(w.rows('SELECT id FROM revocation_tombstones')).toEqual([{ id: 't-fresh' }]);
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
    // an API key, an audit entry with the email, an invite sent to them
    expect((await w.api(w.A.token, 'POST', '/api/keys', { name: 'k' })).status).toBeLessThan(300);
    w.db.sqlite.prepare("INSERT INTO invites (token, email, invited_by, expires_at, workspace_id) VALUES ('tok', 'a@example.com', ?, 9999999999, ?)").run(adminId, w.B.ws);
    expect(w.rows('SELECT COUNT(*) n FROM audit_log WHERE actor_email = ?', 'a@example.com')[0].n).toBeGreaterThan(0);

    const t = await w.api(w.A.token, 'POST', `/api/workspaces/${w.A.ws}/transfer-ownership`, { user_id: adminId });
    expect(t.status).toBe(200);
    expect(w.rows('SELECT user_id, role FROM memberships WHERE workspace_id = ? AND role = ?', w.A.ws, 'owner')).toEqual([{ user_id: adminId, role: 'owner' }]);

    const res = await w.api(w.A.token, 'DELETE', '/api/account', { confirm: 'a@example.com' });
    expect(res.status).toBe(200);
    expect(w.rows('SELECT id FROM users WHERE id = ?', aId)).toEqual([]);
    for (const t of ['sessions', 'auth_accounts']) expect(w.rows(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, aId)[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) n FROM api_keys WHERE user_id = ?', aId)[0].n).toBe(0);
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

  it('API keys cannot delete accounts', async () => {
    const w = await world();
    const key = await json(await w.api(w.B.token, 'POST', '/api/keys', { name: 'k' }));
    const raw = key.key ?? key.token;
    expect(raw).toBeTruthy();
    expect((await w.api(raw, 'DELETE', '/api/account', { confirm: 'b@example.com' })).status).toBe(403);
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
