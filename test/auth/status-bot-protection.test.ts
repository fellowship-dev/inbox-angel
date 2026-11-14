// A hosted instance without Turnstile keys creates no new accounts (sign-up fails closed with 503), while existing users still
// sign in and reset their password: the status must say exactly that.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner } from './helpers';

const SAAS = { MODE: 'saas', SAAS_ENABLED: '1' };
const status = async (env: ReturnType<typeof makeEnv>) => await (await call(env, 'GET', '/api/auth/status')).json() as any;
const REASON = 'bot_protection_not_configured';

describe('GET /api/auth/status on a hosted instance', () => {
  it('with the secret and the site key: sign-up and sign-in are open, with no reason', async () => {
    const s = await status(makeEnv(createMigratedD1(), { ...SAAS, TURNSTILE_SITE_KEY: 'site' }));
    expect(s).toMatchObject({ mode: 'saas', signup_open: true, signin_available: true });
    expect(s).not.toHaveProperty('signup_unavailable_reason');
  });

  it.each([
    ['neither key', { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined }],
    ['the secret but no site key (the page cannot render the widget)', { TURNSTILE_SITE_KEY: undefined }],
    ['the site key but no secret', { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: 'site' }],
    ['empty strings', { TURNSTILE_SECRET_KEY: '', TURNSTILE_SITE_KEY: '' }],
  ])('with %s: closed, with the machine-readable reason', async (_n, keys) => {
    const s = await status(makeEnv(createMigratedD1(), { ...SAAS, ...keys }));
    expect(s).toMatchObject({ mode: 'saas', configured: true, signup_open: false, signup_unavailable_reason: REASON, signin_available: true });
  });

  it('keys held as platform settings count, exactly as the bot check reads them', async () => {
    const db = createMigratedD1();
    const ins = db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', ?, ?)");
    ins.run('turnstile_secret_key', 'sec'); ins.run('turnstile_site_key', 'site');
    const s = await status(makeEnv(db, { ...SAAS, TURNSTILE_SECRET_KEY: undefined }));
    expect(s).toMatchObject({ signup_open: true, signin_available: true });
  });

  it('sign-up fails closed with 503 when the keys are unset; sign-in is not locked (a wrong password is just wrong)', async () => {
    const env = makeEnv(createMigratedD1(), { ...SAAS, TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined });
    const signup = await call(env, 'POST', '/api/auth/signup', { body: { name: 'a', email: 'a@example.com', password: 'password-123' } });
    expect(signup.status).toBe(503);
    expect(((await signup.json()) as any).error).toMatch(/bot protection is not configured/);
    const login = await call(env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'password-123' } });
    expect(login.status).toBe(401);
  });
});

describe('GET /api/auth/status on a self-hosted instance is unchanged', () => {
  it('before and after setup: no reason, sign-in available, sign-up closed', async () => {
    const env = makeEnv(createMigratedD1());
    expect(await status(env)).toMatchObject({ mode: 'self-host', configured: false, signup_open: false, signin_available: true });
    expect(await status(env)).not.toHaveProperty('signup_unavailable_reason');
    await setupOwner(env);
    const s = await status(env);
    expect(s).toMatchObject({ configured: true, signup_open: false, signin_available: true });
    expect(s).not.toHaveProperty('signup_unavailable_reason');
  });
});
