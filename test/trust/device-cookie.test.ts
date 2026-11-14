// The device cookie lets the owner of an account past its per-address sign-in lock from a device that signed in before.
// It must stop doing that after a password change or reset, or "sign out everywhere".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { SIGNIN_FAILURE_LIMIT } from '../../src/auth/welcome';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

let n = 0;
const ip = () => ({ ip: `203.0.113.${++n % 250}` });

async function world() {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send } });
  await signupVerified(env, 'real@example.com', 'password-one-1');
  /** Sign in; returns the device cookie (name=value) and the session token. */
  const signIn = async (password: string) => {
    const res = await call(env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password }, ...ip() });
    expect(res.status).toBe(200);
    const device = ((res.headers as any).getSetCookie() as string[]).find(c => c.startsWith('rsm_device='))!.split(';')[0]!;
    return { device, token: (await json(res)).token as string };
  };
  /** A stranger fails 10 times: the address is locked. */
  const lock = async () => {
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) await call(env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'a-wrong-guess-1' }, ...ip() });
  };
  const withCookie = (password: string, cookie?: string) =>
    call(env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password }, ...(cookie ? { headers: { cookie } } : {}), ...ip() });
  return { db, env, send, signIn, lock, withCookie };
}

describe('the device cookie follows the account\'s password and sessions', () => {
  it('works while nothing changed; an old three-part cookie does not', async () => {
    const w = await world();
    const { device } = await w.signIn('password-one-1');
    expect(device.split('=')[1]!.split('.')).toHaveLength(4);
    await w.lock();
    expect((await w.withCookie('password-one-1')).status).toBe(429);
    expect((await w.withCookie('password-one-1', device)).status).toBe(200);
    await w.lock();
    const [uid, exp, , mac] = device.split('=')[1]!.split('.');
    expect((await w.withCookie('password-one-1', `rsm_device=${uid}.${exp}.${mac}`)).status).toBe(429);
  });

  it('a password reset ends it', async () => {
    const w = await world();
    const { device } = await w.signIn('password-one-1');
    await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'real@example.com' }, ...ip() });
    const token = ((w.send.mock.calls.at(-1) as any)[0].text as string).match(/#\/reset\/([A-Za-z0-9_-]+)/)![1];
    expect((await call(w.env, 'POST', '/api/auth/reset', { body: { token, password: 'password-two-2' }, ...ip() })).status).toBe(200);
    await w.lock();
    expect((await w.withCookie('password-two-2', device)).status).toBe(429);
  });

  it('a password change ends it', async () => {
    const w = await world();
    const { device, token } = await w.signIn('password-one-1');
    const changed = await call(w.env, 'POST', '/api/auth/change-password', { key: token, body: { currentPassword: 'password-one-1', newPassword: 'password-three-3' }, ...ip() });
    expect(changed.status).toBe(200);
    await w.lock();
    expect((await w.withCookie('password-three-3', device)).status).toBe(429);
  });

  it('"sign out everywhere" ends it, and a later sign-in gets a cookie that works', async () => {
    const w = await world();
    const { device, token } = await w.signIn('password-one-1');
    const revoked = await call(w.env, 'POST', '/api/auth/revoke-sessions', { key: token, body: {}, ...ip() });
    expect(revoked.status).toBe(200);
    const { device: next } = await w.signIn('password-one-1');
    await w.lock();
    expect((await w.withCookie('password-one-1', device)).status).toBe(429);
    expect((await w.withCookie('password-one-1', next)).status).toBe(200);
  });

  it('signing out of one session does not end it', async () => {
    const w = await world();
    const { device, token } = await w.signIn('password-one-1');
    expect((await call(w.env, 'POST', '/api/auth/logout', { key: token, ...ip() })).status).toBe(200);
    await w.lock();
    expect((await w.withCookie('password-one-1', device)).status).toBe(200);
  });
});
