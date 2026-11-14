// Item 1: handing a workspace over cannot push the new owner past the hosted workspace cap.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { hosted, json, nxdomain } from './helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(nxdomain);
afterEach(() => vi.unstubAllGlobals());

async function setup(targetOwns: number) {
  const w = await hosted({ BOOKING_URL: 'https://cal.example.com/max' });
  const from = await w.user('from@example.com');
  const to = await w.user('to@example.com');
  for (let i = 1; i < targetOwns; i++) expect((await w.api(to, 'POST', '/api/workspaces', { name: `W${i}` })).status).toBe(201);
  w.db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')").run(from.ws, to.id);
  const roles = () => Object.fromEntries(w.rows('SELECT user_id, role FROM memberships WHERE workspace_id = ?', from.ws).map(r => [r.user_id, r.role]));
  return { ...w, from, to, roles };
}

describe('transfer-ownership and the workspaces-per-user cap', () => {
  it('refuses with 403 plan_limit when the target already owns 5; roles, audit and legacy role are unchanged', async () => {
    const w = await setup(5);
    const before = w.roles();
    const legacy = w.rows('SELECT id, role FROM users ORDER BY id');
    const res = await w.api(w.from, 'POST', `/api/workspaces/${w.from.ws}/transfer-ownership`, { user_id: w.to.id });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'You have reached the limit of 5 workspaces you can own.', code: 'plan_limit', limit: { kind: 'workspaces_per_user', max: 5 }, help_url: 'https://cal.example.com/max' });
    expect(w.roles()).toEqual(before);
    expect(w.rows("SELECT * FROM audit_log WHERE action = 'workspace.ownership_transferred'")).toEqual([]);
    expect(w.rows('SELECT id, role FROM users ORDER BY id')).toEqual(legacy);
  });

  it('works when the target owns 4 (the transfer makes 5)', async () => {
    const w = await setup(4);
    const res = await w.api(w.from, 'POST', `/api/workspaces/${w.from.ws}/transfer-ownership`, { user_id: w.to.id });
    expect(res.status).toBe(200);
    expect(w.roles()).toEqual({ [w.from.id]: 'admin', [w.to.id]: 'owner' });
  });

  it('a target that already co-owns this workspace is not gaining a workspace, so the cap does not block the hand-over', async () => {
    const w = await setup(5);
    w.db.sqlite.prepare("UPDATE memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").run(w.from.ws, w.to.id); // the 6th ownership, via another route
    // The promotion matches no row at the cap, but the target already owns here: the demotion still applies, and nothing new is owned.
    const res = await w.api(w.from, 'POST', `/api/workspaces/${w.from.ws}/transfer-ownership`, { user_id: w.to.id });
    expect(res.status).toBe(200);
    expect(w.roles()).toEqual({ [w.from.id]: 'admin', [w.to.id]: 'owner' });
  });

  it('self-host is uncapped', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
    const ownerId = rows("SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    db.sqlite.prepare("INSERT INTO users (id, email, email_verified, name) VALUES ('u2', 'u2@example.com', 1, 'u2')").run();
    db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'u2', 'member')").run();
    for (let i = 0; i < 6; i++) {
      db.sqlite.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(`x${i}`, `x${i}`);
      db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, 'u2', 'owner')").run(`x${i}`);
    }
    const res = await call(env, 'POST', '/api/workspaces/ws_default/transfer-ownership', { key: owner, body: { user_id: 'u2' } });
    expect(res.status).toBe(200);
    expect(rows("SELECT role FROM memberships WHERE workspace_id = 'ws_default' AND user_id = 'u2'")[0].role).toBe('owner');
    expect(ownerId).toBeTruthy();
  });
});
