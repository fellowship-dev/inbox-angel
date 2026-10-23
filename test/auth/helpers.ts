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
  return { DB: db as unknown as D1Database, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_ZONE_ID: '', CLOUDFLARE_API_TOKEN: '', ...extra } as unknown as Env;
}

let ipCounter = 0;
/** A distinct client IP per call, so the D1 rate limiter does not couple tests. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export function req(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip ?? freshIp(), ...opts.headers };
  if (opts.key) headers['x-api-key'] = opts.key;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
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
  return (await acc.json() as { token: string }).token;
}

