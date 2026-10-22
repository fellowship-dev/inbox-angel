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
import { call, ctx, makeEnv, setupOwner, inviteAndAccept, req } from './helpers';
import { handleApi } from '../../src/api/router';

const rows = (db: ReturnType<typeof createMigratedD1>, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

describe('self-host: first signup and login', () => {
  it('first signup becomes owner of acct_default; setup then closes', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const status = await (await call(env, 'GET', '/api/auth/status')).json() as any;
    expect(status).toMatchObject({ configured: false, mode: 'self-host', signup_open: false });

    const token = await setupOwner(env);
    expect(token).toBeTruthy();
    expect(rows(db, 'SELECT account_id, role FROM memberships')).toEqual([{ account_id: 'acct_default', role: 'owner' }]);
    expect(rows(db, 'SELECT COUNT(*) n FROM accounts')).toEqual([{ n: 1 }]);

    expect(((await (await call(env, 'GET', '/api/auth/status')).json()) as any).configured).toBe(true);
    const again = await call(env, 'POST', '/api/auth/setup', { body: { email: 'other@example.com', password: 'another-password' } });
    expect(again.status).toBe(409);
    expect(rows(db, 'SELECT COUNT(*) n FROM users')).toEqual([{ n: 1 }]);
  });

  it('cannot sign up directly through Better Auth, nor via /api/auth/signup, once owned', async () => {
    const env = makeEnv();
    await setupOwner(env);
    const direct = await call(env, 'POST', '/api/auth/sign-up/email', { body: { name: 'x', email: 'x@example.com', password: 'password-123' } });
    expect(direct.status).toBe(404);
    const signup = await call(env, 'POST', '/api/auth/signup', { body: { email: 'x@example.com', password: 'password-123' } });
    expect(signup.status).toBe(403);
  });

  it('logs in with the right password, rejects the wrong one with the same answer for unknown users', async () => {
    const env = makeEnv();
    await setupOwner(env, 'owner@example.com', 'correct-horse-battery');

    const ok = await call(env, 'POST', '/api/auth/login', { body: { email: 'Owner@Example.com', password: 'correct-horse-battery' } });
    expect(ok.status).toBe(200);
    const { token } = await ok.json() as { token: string };
    expect((await call(env, 'GET', '/api/domains', { key: token })).status).toBe(200);

    const wrong = await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'nope-nope-nope' } });
    const unknown = await call(env, 'POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'nope-nope-nope' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('logout ends the session', async () => {
    const env = makeEnv();
    const token = await setupOwner(env);
    expect((await call(env, 'GET', '/api/domains', { key: token })).status).toBe(200);
    expect((await call(env, 'POST', '/api/auth/logout', { key: token })).status).toBe(200);
    expect((await call(env, 'GET', '/api/domains', { key: token })).status).toBe(401);
  });

  it('a session cookie authenticates too (OAuth sign-in), and enforces same-origin on writes', async () => {
    const env = makeEnv();
    await setupOwner(env);
    const login = await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    expect(cookie).toContain('session_token');

    expect((await call(env, 'GET', '/api/domains', { headers: { cookie } })).status).toBe(200);
    // Cross-site write with the cookie → rejected
    const evil = await call(env, 'POST', '/api/domains', { headers: { cookie, origin: 'https://evil.example' }, body: { domain: 'victim.com' } });
    expect(evil.status).toBe(403);
    // No Origin and not same-origin per Fetch Metadata → rejected
    const nometa = await call(env, 'POST', '/api/domains', { headers: { cookie, 'sec-fetch-site': 'cross-site' }, body: { domain: 'victim.com' } });
    expect(nometa.status).toBe(403);
    // Same-origin write passes the CSRF check (and fails later for unrelated reasons, not 403)
    const same = await call(env, 'POST', '/api/domains', { headers: { cookie, origin: 'https://ia.example.com' }, body: { domain: '' } });
    expect(same.status).not.toBe(403);
    // Header credentials are not subject to the origin check
    const token = (await (await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } })).json() as any).token;
    const viaHeader = await call(env, 'POST', '/api/domains', { key: token, headers: { origin: 'https://evil.example' }, body: { domain: '' } });
    expect(viaHeader.status).not.toBe(403);
  });
});

describe('invites map to memberships', () => {
  it('admin and member invites become memberships with that role; the invite is single-use', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);

    const inv = await call(env, 'POST', '/api/team/invite', { key: owner, body: { email: 'new@example.com', role: 'admin' } });
    const { token } = await inv.json() as { token: string };
    const info = await call(env, 'GET', `/api/invites/${token}`);
    expect(await info.json()).toMatchObject({ email: 'new@example.com', role: 'admin' });

    const acc = await call(env, 'POST', `/api/invites/${token}`, { body: { name: 'New', password: 'invitee-password-1' } });
    expect(acc.status).toBe(201);
    expect(rows(db, "SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'new@example.com'")).toEqual([{ role: 'admin' }]);
    expect(rows(db, 'SELECT COUNT(*) n FROM accounts')).toEqual([{ n: 1 }]);

    const reuse = await call(env, 'POST', `/api/invites/${token}`, { body: { name: 'Again', password: 'invitee-password-1' } });
    expect(reuse.status).toBe(404);

    await inviteAndAccept(env, owner, 'mem@example.com', 'member');
    expect(rows(db, 'SELECT role FROM memberships ORDER BY role')).toEqual([{ role: 'admin' }, { role: 'member' }, { role: 'owner' }]);
  });

  it('an expired invite cannot be accepted', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const { token } = await (await call(env, 'POST', '/api/team/invite', { key: owner, body: { email: 'late@example.com' } })).json() as any;
    db.sqlite.prepare('UPDATE invites SET expires_at = 1 WHERE token = ?').run(token);
    expect((await call(env, 'POST', `/api/invites/${token}`, { body: { name: 'L', password: 'invitee-password-1' } })).status).toBe(404);
  });

  it('the owner cannot be removed; admins cannot remove admins', async () => {
    const env = makeEnv();
    const owner = await setupOwner(env);
    const admin = await inviteAndAccept(env, owner, 'a1@example.com', 'admin');
    await inviteAndAccept(env, owner, 'a2@example.com', 'admin');
    const team = await (await call(env, 'GET', '/api/team', { key: admin })).json() as any;
    const byEmail = (e: string) => team.users.find((u: any) => u.email === e);
    expect(byEmail('owner@example.com').role).toBe('owner');
    expect((await call(env, 'DELETE', `/api/team/${byEmail('owner@example.com').id}`, { key: admin })).status).toBe(403);
    expect((await call(env, 'DELETE', `/api/team/${byEmail('a2@example.com').id}`, { key: admin })).status).toBe(403);
    expect((await call(env, 'DELETE', `/api/team/${byEmail('a2@example.com').id}`, { key: owner })).status).toBe(200);
  });
});

describe('MODE=saas: an account per signup', () => {
  it('each signup creates its own account and owner membership; setup is refused', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    const status = await (await call(env, 'GET', '/api/auth/status')).json() as any;
    expect(status).toMatchObject({ mode: 'saas', signup_open: true, configured: true });

    expect((await call(env, 'POST', '/api/auth/setup', { body: { email: 'a@example.com', password: 'password-123' } })).status).toBe(409);
    for (const e of ['a@example.com', 'b@example.com']) {
      const r = await call(env, 'POST', '/api/auth/signup', { body: { name: e, email: e, password: 'password-123' } });
      expect(r.status).toBe(201);
    }
    const ms = rows(db, "SELECT m.account_id, m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.email");
    expect(ms.map(m => m.role)).toEqual(['owner', 'owner']);
    expect(new Set(ms.map(m => m.account_id)).size).toBe(2);
    expect(ms.every(m => m.account_id !== 'acct_default')).toBe(true);
    expect(rows(db, 'SELECT COUNT(*) n FROM accounts')).toEqual([{ n: 3 }]);
  });

  it('self-host refuses /api/auth/signup', async () => {
    const env = makeEnv();
    expect((await call(env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } })).status).toBe(403);
  });
});

describe('first-run races', () => {
  it('two simultaneous first signups: exactly one owner', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const [a, b] = await Promise.all([
      handleApi(req('POST', '/api/auth/setup', { body: { email: 'a@example.com', password: 'password-123' } }), env, ctx),
      handleApi(req('POST', '/api/auth/setup', { body: { email: 'b@example.com', password: 'password-123' } }), env, ctx),
    ]);
    expect([a.status, b.status].filter(s => s === 201)).toHaveLength(1);
    expect(rows(db, "SELECT COUNT(*) n FROM memberships WHERE role = 'owner'")).toEqual([{ n: 1 }]);
    expect(rows(db, 'SELECT COUNT(*) n FROM users')).toEqual([{ n: 1 }]);
  });
});
