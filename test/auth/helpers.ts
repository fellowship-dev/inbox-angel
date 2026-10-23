import { vi } from 'vitest';
import type { Env } from '../../src/index';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';

export const BASE = 'https://ia.example.com';
export const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

export type TestDb = ReturnType<typeof createMigratedD1>;

export function makeEnv(db: TestDb = createMigratedD1(), extra: Record<string, unknown> = {}): Env {
  // The platform's sender address, as the setup wizard would have stored it.
  db.sqlite.prepare("INSERT OR IGNORE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.example.com')").run();
  // Hosted sign-up is closed without a Turnstile secret; tests send the token 'ok' (see test/setup-files/turnstile.ts).
  const turnstile = extra.MODE === 'saas' ? { TURNSTILE_SECRET_KEY: 'test-turnstile-secret' } : {};
  return { DB: db as unknown as D1Database, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_ZONE_ID: '', CLOUDFLARE_API_TOKEN: '', ...turnstile, ...extra } as unknown as Env;
}

let ipCounter = 0;
/** A distinct client IP per call, so the D1 rate limiter does not couple tests. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export function req(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip ?? freshIp(), ...opts.headers };
  if (opts.key) headers['x-api-key'] = opts.key;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let body = opts.body;
  if (/^\/api\/auth\/(signup|login|setup)$/.test(path) && body && typeof body === 'object' && !('cf_turnstile_token' in body)) body = { ...body, cf_turnstile_token: 'ok' };
  return new Request(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

export const call = (env: Env, ...args: Parameters<typeof req>) => handleApi(req(...args), env, ctx);

export async function setupOwner(env: Env, email = 'owner@example.com', password = 'correct-horse-battery') {
  const res = await call(env, 'POST', '/api/auth/setup', { body: { email, password } });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  return (await res.json() as { token: string }).token;
}

/** Owner invites `email` with `role`; the invitee accepts. Returns their session token. */
export async function inviteAndAccept(env: Env, ownerToken: string, email: string, role: 'admin' | 'member', password = 'invitee-password-1') {
  const inv = await call(env, 'POST', '/api/team/invite', { key: ownerToken, body: { email, role } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${await inv.text()}`);
  const { token } = await inv.json() as { token: string };
  const acc = await call(env, 'POST', `/api/invites/${token}`, { body: { name: email.split('@')[0], password } });
  if (acc.status !== 201) throw new Error(`accept failed: ${acc.status} ${await acc.text()}`);
  const { token: session, invite_pending } = await acc.json() as { token: string | null; invite_pending?: boolean };
  if (session) return session;
  // Hosted: the link alone proves nothing. The invitee gets an ordinary account, verifies it (as the emailed link would),
  // signs in and accepts the invite as that verified address.
  const sql = (env.DB as unknown as TestDb).sqlite;
  sql.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email.toLowerCase());
  const login = await call(env, 'POST', '/api/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const bearer = (await login.json() as { token: string }).token;
  if (invite_pending) {
    const done = await call(env, 'POST', `/api/invites/${token}`, { key: bearer, body: {} });
    if (done.status !== 200) throw new Error(`accept failed: ${done.status} ${await done.text()}`);
    // Tests act as a plain member of the inviting workspace: leave the personal workspace sign-up created out of it.
    const inviting = (sql.prepare('SELECT workspace_id FROM invites WHERE token = ?').get(token) as { workspace_id: string }).workspace_id;
    sql.prepare('DELETE FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = ?) AND workspace_id != ?').run(email.toLowerCase(), inviting);
  }
  return bearer;
}


/**
 * Hosted sign-up as a verified user: sign up (no session yet: the mailbox is unproven), mark the address verified as
 * clicking the emailed link would, then log in. Returns the session token.
 */
export async function signupVerified(env: Env, email: string, password = 'password-123', name = email) {
  const res = await call(env, 'POST', '/api/auth/signup', { body: { name, email, password } });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  (env.DB as unknown as TestDb).sqlite.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email.toLowerCase());
  const login = await call(env, 'POST', '/api/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  return (await login.json() as { token: string }).token;
}
