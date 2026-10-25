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
import { call, makeEnv, setupOwner, freshIp } from './helpers';

const rows = (db: ReturnType<typeof createMigratedD1>, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

function envWithMail(db = createMigratedD1(), extra: Record<string, unknown> = {}) {
  const send = vi.fn().mockResolvedValue(undefined);
  return { env: makeEnv(db, { SEND_EMAIL: { send }, ...extra }), send, db };
}
const tokenFrom = (text: string) => text.match(/#\/reset\/([A-Za-z0-9_-]+)/)![1];

describe('password reset', () => {
  it('emails a link through the existing mail path; the answer is identical for unknown addresses', async () => {
    const { env, send } = envWithMail();
    await setupOwner(env, 'owner@example.com');

    const known = await call(env, 'POST', '/api/auth/forgot', { body: { email: 'owner@example.com' } });
    const unknown = await call(env, 'POST', '/api/auth/forgot', { body: { email: 'ghost@example.com' } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());

    // background work (the mail) completes via ctx.waitUntil; await what was scheduled
    await Promise.all((ctxCalls()).map(p => p));
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(['owner@example.com']);
    expect(mail.from).toEqual({ name: 'InboxAngel', email: 'noreply@reports.example.com' });
    expect(mail.text).toContain('https://ia.example.com/#/reset/');
  });

  it('resets the password: new one works, old one and old sessions do not; link is single-use', async () => {
    const { env, send } = envWithMail();
    const session = await setupOwner(env, 'owner@example.com', 'old-password-123');
    await call(env, 'POST', '/api/auth/forgot', { body: { email: 'owner@example.com' } });
    await Promise.all(ctxCalls());
    const token = tokenFrom(send.mock.calls[0][0].text);

    const reset = await call(env, 'POST', '/api/auth/reset', { body: { token, password: 'brand-new-password' } });
    expect(reset.status).toBe(200);
    const { token: fresh } = await reset.json() as { token: string };
    expect((await call(env, 'GET', '/api/domains', { key: fresh })).status).toBe(200);
    expect((await call(env, 'GET', '/api/domains', { key: session })).status).toBe(401); // old sessions revoked

    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'old-password-123' } })).status).toBe(401);
    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'brand-new-password' } })).status).toBe(200);

    expect((await call(env, 'POST', '/api/auth/reset', { body: { token, password: 'another-password-1' } })).status).toBe(400);
  });

  it('rejects bad tokens, expired tokens and short passwords', async () => {
    const { env, send, db } = envWithMail();
    await setupOwner(env, 'owner@example.com');
    expect((await call(env, 'POST', '/api/auth/reset', { body: { token: 'nope', password: 'brand-new-password' } })).status).toBe(400);

    await call(env, 'POST', '/api/auth/forgot', { body: { email: 'owner@example.com' } });
    await Promise.all(ctxCalls());
    const token = tokenFrom(send.mock.calls[0][0].text);
    expect((await call(env, 'POST', '/api/auth/reset', { body: { token, password: 'short' } })).status).toBe(400);
    db.sqlite.prepare('UPDATE verifications SET expires_at = 1').run();
    expect((await call(env, 'POST', '/api/auth/reset', { body: { token, password: 'brand-new-password' } })).status).toBe(400);
  });

  it('without SEND_EMAIL nothing is sent and the log carries a static reason, never the link or address', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = makeEnv();
    await setupOwner(env, 'owner@example.com');
    await call(env, 'POST', '/api/auth/forgot', { body: { email: 'owner@example.com' } });
    await Promise.all(ctxCalls());
    expect(log.mock.calls.some(c => String(c[0]).includes('[auth] reset email not sent: SEND_EMAIL binding not configured'))).toBe(true);
    const out = JSON.stringify([...log.mock.calls, ...other.mock.calls]);
    expect(out).not.toContain('owner@example.com');
    expect(out).not.toContain('#/reset/');
    log.mockRestore();
    other.mockRestore();
  });

  it('does not surface mail failures (no enumeration via errors)', async () => {
    const { env, send } = envWithMail();
    await setupOwner(env, 'owner@example.com');
    send.mockRejectedValue(new Error('destination address not verified'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(env, 'POST', '/api/auth/forgot', { body: { email: 'owner@example.com' } });
    await Promise.all(ctxCalls());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    err.mockRestore();
  });
});

import { ctx } from './helpers';
/** Promises handed to ctx.waitUntil since the last call. */
function ctxCalls(): Promise<unknown>[] {
  const calls = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as Promise<unknown>);
  (ctx.waitUntil as ReturnType<typeof vi.fn>).mockClear();
  return calls;
}

describe('rate limits', () => {
  it('login: the 11th attempt in a minute from one IP is 429; another IP is unaffected', async () => {
    const env = makeEnv();
    await setupOwner(env);
    const ip = freshIp();
    const attempt = (from: string) => call(env, 'POST', '/api/auth/login', { ip: from, body: { email: 'owner@example.com', password: 'wrong-password' } });
    for (let i = 0; i < 10; i++) expect((await attempt(ip)).status).toBe(401);
    const blocked = await attempt(ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await attempt(freshIp())).status).toBe(401);
    // and even the right password is refused while limited
    expect((await call(env, 'POST', '/api/auth/login', { ip, body: { email: 'owner@example.com', password: 'correct-horse-battery' } })).status).toBe(429);
  });

  it('signup (saas): limited per IP per hour', async () => {
    const env = makeEnv(createMigratedD1(), { MODE: 'saas', SAAS_ENABLED: '1' });
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await call(env, 'POST', '/api/auth/signup', { ip, body: { email: `u${i}@example.com`, password: 'password-123' } })).status);
    }
    expect(statuses.slice(0, 10).every(s => s === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('password reset requests: limited per IP, with the same body shape', async () => {
    const { env } = envWithMail();
    await setupOwner(env);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await call(env, 'POST', '/api/auth/forgot', { ip, body: { email: `x${i}@example.com` } })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('the Cloudflare AUTH_LIMITER binding, when present, is honoured too', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = makeEnv(createMigratedD1(), { AUTH_LIMITER: { limit } });
    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'password-123' } })).status).toBe(429);
    expect((await call(env, 'POST', '/api/auth/setup', { body: { email: 'a@example.com', password: 'password-123' } })).status).toBe(429);
    expect(limit).toHaveBeenCalled();
  });

  it('the D1 limiter window resets', async () => {
    const { d1RateLimitStorage } = await import('../../src/auth/rate-limit');
    const db = createMigratedD1();
    const store = d1RateLimitStorage(db as unknown as D1Database);
    const rule = { window: 60, max: 2 };
    expect((await store.consume('k', rule)).allowed).toBe(true);
    expect((await store.consume('k', rule)).allowed).toBe(true);
    expect((await store.consume('k', rule)).allowed).toBe(false);
    db.sqlite.prepare('UPDATE auth_rate_limits SET last_request = last_request - 61000').run();
    expect((await store.consume('k', rule)).allowed).toBe(true);
  });
});
