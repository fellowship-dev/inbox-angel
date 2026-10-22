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

import { createMigratedD1, createTestD1, applyMigrations } from '@inbox-angel/db/testing';
import { call, ctx, makeEnv, setupOwner, inviteAndAccept, req } from './helpers';
import { hashPassword } from '../../src/api/password';
import { sessionAccountResolver } from '../../src/auth/resolver';
import { createApiKey } from '../../src/auth/api-keys';

const rows = (db: { sqlite: any }, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
const ask = (env: Env, key?: string, headers: Record<string, string> = {}) =>
  sessionAccountResolver(req('GET', '/api/domains', { key, headers }), env);

describe('AccountResolver: session → user → membership → account', () => {
  it('maps a session to its account, user and role', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    const member = await inviteAndAccept(env, owner, 'm@example.com', 'member');
    const ownerId = rows(db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    const memberId = rows(db, "SELECT id FROM users WHERE email = 'm@example.com'")[0].id;

    expect(await ask(env, owner)).toEqual({ accountId: 'acct_default', userId: ownerId, role: 'owner' });
    expect(await ask(env, member)).toEqual({ accountId: 'acct_default', userId: memberId, role: 'member' });
  });

  it('saas: each signup resolves to its own account', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    const tok = async (e: string) => ((await (await call(env, 'POST', '/api/auth/signup', { body: { email: e, password: 'password-123' } })).json()) as any).token as string;
    const [a, b] = [await tok('a@example.com'), await tok('b@example.com')];
    const [ra, rb] = [await ask(env, a), await ask(env, b)];
    expect(ra!.accountId).not.toBe(rb!.accountId);
    expect(ra).toMatchObject({ role: 'owner' });
    expect(rows(db, 'SELECT account_id FROM memberships WHERE user_id = ?', ra!.userId)).toEqual([{ account_id: ra!.accountId }]);
  });

  it('a user in several accounts picks one with X-Account-Id, and cannot pick one they are not in', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    const a = ((await (await call(env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } })).json()) as any).token as string;
    const b = ((await (await call(env, 'POST', '/api/auth/signup', { body: { email: 'b@example.com', password: 'password-123' } })).json()) as any).token as string;
    const [accA, accB] = [(await ask(env, a))!.accountId, (await ask(env, b))!.accountId];
    const userA = (await ask(env, a))!.userId!;
    db.sqlite.prepare("INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?, ?, 'member', unixepoch() + 100)").run(accB, userA);

    expect((await ask(env, a))!.accountId).toBe(accA); // oldest membership by default
    expect(await ask(env, a, { 'x-account-id': accB })).toMatchObject({ accountId: accB, role: 'member' });
    expect(await ask(env, b, { 'x-account-id': accA })).toBeNull(); // b is not in a's account
  });

  it('API keys resolve to their account; the instance key to acct_default; nothing resolves to null', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { API_KEY: 'instance-secret-key' });
    const owner = await setupOwner(env);
    const userId = rows(db, 'SELECT id FROM users')[0].id;
    const { key } = await createApiKey(db as unknown as D1Database, { accountId: 'acct_default', userId, name: 'k' });

    expect(await ask(env, key)).toEqual({ accountId: 'acct_default', userId, role: 'owner' });
    expect(await ask(env, 'instance-secret-key')).toEqual({ accountId: 'acct_default', userId: undefined, role: 'owner' });
    expect(await ask(env)).toBeNull();
    expect(await ask(env, 'nonsense')).toBeNull();
    expect(owner).toBeTruthy();
  });

  it('a signed-in user with no membership resolves to null (and the API says 403)', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    db.sqlite.prepare('DELETE FROM memberships').run();
    expect(await ask(env, owner)).toBeNull();
    expect((await call(env, 'GET', '/api/domains', { key: owner })).status).toBe(403);
  });
});

// ── Upgrade from a pre-auth database ──────────────────────────

describe('upgrade from a pre-Better-Auth database', () => {

  async function legacyInstall() {
    const d = createTestD1();
    applyMigrations(d.sqlite, { through: '0011_report_records_enrichment.sql' }); // the last release before accounts and Better Auth
    const hash = await hashPassword('my-old-password');
    const memberHash = await hashPassword('member-old-password');
    d.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, session_token, created_at) VALUES ('u-admin','admin@old.test','Admin',?, 'admin','legacy-session-token', 100)").run(hash);
    d.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u-mem','mem@old.test','Mem',?, 'member', 200)").run(memberHash);
    d.sqlite.prepare("INSERT INTO users (id, email, name, role, created_at) VALUES ('u-nopw','nopw@old.test','NoPw','member', 300)").run();
    d.sqlite.prepare("INSERT INTO domains (domain, rua_address) VALUES ('old.example.com','rua@reports.old.test')").run();
    d.sqlite.prepare("INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ('old-reset-token','u-admin', 9999999999)").run();
    return d;
  }

  it('applies cleanly and keeps users, roles and data', async () => {
    const d = await legacyInstall();
    expect(applyMigrations(d.sqlite)).toEqual(['0012_accounts.sql', '0013_better_auth.sql']);
    expect(rows(d, 'SELECT id, email, role FROM users ORDER BY created_at')).toEqual([
      { id: 'u-admin', email: 'admin@old.test', role: 'admin' },
      { id: 'u-mem', email: 'mem@old.test', role: 'member' },
      { id: 'u-nopw', email: 'nopw@old.test', role: 'member' },
    ]);
    expect(rows(d, 'SELECT user_id, role FROM memberships ORDER BY user_id')).toEqual([
      { user_id: 'u-admin', role: 'owner' }, { user_id: 'u-mem', role: 'member' }, { user_id: 'u-nopw', role: 'member' },
    ]);
    expect(rows(d, 'SELECT COUNT(*) n FROM domains')).toEqual([{ n: 1 }]);
    // password hashes became credential logins, byte for byte; users without a password got none
    const creds = rows(d, "SELECT user_id, provider_id, provider_account_id, password FROM auth_accounts ORDER BY user_id");
    expect(creds.map(c => [c.user_id, c.provider_id, c.provider_account_id])).toEqual([['u-admin', 'credential', 'u-admin'], ['u-mem', 'credential', 'u-mem']]);
    expect(creds[0].password).toBe(rows(d, "SELECT password_hash FROM users WHERE id = 'u-admin'")[0].password_hash);
    expect(rows(d, 'SELECT COUNT(*) n FROM sessions')).toEqual([{ n: 0 }]);
  });

  it('existing admins and members log in with their old passwords', async () => {
    const d = await legacyInstall();
    applyMigrations(d.sqlite);
    const env = makeEnv(d as any);

    const status = await (await call(env, 'GET', '/api/auth/status')).json() as any;
    expect(status.configured).toBe(true);

    const login = await call(env, 'POST', '/api/auth/login', { body: { email: 'admin@old.test', password: 'my-old-password' } });
    expect(login.status).toBe(200);
    const { token } = await login.json() as { token: string };
    expect((await call(env, 'GET', '/api/domains', { key: token })).status).toBe(200);
    expect((await call(env, 'GET', '/api/team', { key: token })).status).toBe(200); // still the owner
    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'admin@old.test', password: 'wrong' } })).status).toBe(401);

    const mem = await call(env, 'POST', '/api/auth/login', { body: { email: 'mem@old.test', password: 'member-old-password' } });
    expect(mem.status).toBe(200);
    const memberToken = ((await mem.json()) as any).token;
    expect((await call(env, 'GET', '/api/domains', { key: memberToken })).status).toBe(200);
    expect((await call(env, 'POST', '/api/domains', { key: memberToken, body: { domain: 'x.example.com' } })).status).toBe(403);
  });

  it('old sessions are invalidated (documented); setup stays closed; old reset links are dead', async () => {
    const d = await legacyInstall();
    applyMigrations(d.sqlite);
    const env = makeEnv(d as any);
    expect((await call(env, 'GET', '/api/domains', { key: 'legacy-session-token' })).status).toBe(401);
    expect((await call(env, 'POST', '/api/auth/setup', { body: { email: 'evil@x.test', password: 'password-123' } })).status).toBe(409);
    expect((await call(env, 'POST', '/api/auth/reset', { body: { token: 'old-reset-token', password: 'password-1234' } })).status).toBe(400);
  });

  it('a migrated user can change their password via the reset flow', async () => {
    const d = await legacyInstall();
    applyMigrations(d.sqlite);
    const send = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(d as any, { SEND_EMAIL: { send } });
    await call(env, 'POST', '/api/auth/forgot', { body: { email: 'admin@old.test' } });
    await Promise.all((ctx.waitUntil as any).mock.calls.map((c: any[]) => c[0]));
    const token = send.mock.calls.at(-1)![0].text.match(/#\/reset\/([A-Za-z0-9_-]+)/)[1];
    expect((await call(env, 'POST', '/api/auth/reset', { body: { token, password: 'a-new-password-1' } })).status).toBe(200);
    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'admin@old.test', password: 'a-new-password-1' } })).status).toBe(200);
  });

  it('a 0.9.x install (login still in settings) lands as an owner who can log in', async () => {
    const d = createTestD1();
    applyMigrations(d.sqlite, { through: '0011_report_records_enrichment.sql' });
    const hash = await hashPassword('ancient-password');
    d.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('password_hash', ?), ('user_email', 'ancient@old.test'), ('user_name', 'Ancient'), ('session_token', 's1')").run(hash);
    applyMigrations(d.sqlite);
    const env = makeEnv(d as any);
    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'ancient@old.test', password: 'ancient-password' } })).status).toBe(200);
    expect(rows(d, 'SELECT role FROM memberships')).toEqual([{ role: 'owner' }]);
  });

  it('is idempotent with the single migrate path: re-applying changes nothing', async () => {
    const d = await legacyInstall();
    applyMigrations(d.sqlite);
    const before = rows(d, 'SELECT COUNT(*) n FROM auth_accounts');
    expect(applyMigrations(d.sqlite)).toEqual([]);
    expect(rows(d, 'SELECT COUNT(*) n FROM auth_accounts')).toEqual(before);
  });
});
