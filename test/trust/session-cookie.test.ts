// The browser session lives in an HttpOnly cookie; bearer tokens are for scripts and API keys.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner, BASE } from '../auth/helpers';

const setCookies = (r: Response) => (r.headers as any).getSetCookie() as string[];

describe('browser sessions', () => {
  async function owner() {
    const env = makeEnv(createMigratedD1(), { BETTER_AUTH_URL: BASE });
    await setupOwner(env, 'owner@example.com', 'correct-horse-battery');
    return env;
  }

  it('a browser login gets an HttpOnly, SameSite=Lax, Secure cookie and no token in the body or headers', async () => {
    const env = await owner();
    const res = await call(env, 'POST', '/api/auth/login', { headers: { origin: BASE }, body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toMatch(/token/);
    expect(res.headers.get('set-auth-token')).toBeNull();
    const session = setCookies(res).find(c => /session_token=/.test(c))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Secure/i);
  });

  it('the cookie alone authenticates; a state-changing request from another origin with it is refused (CSRF)', async () => {
    const env = await owner();
    const login = await call(env, 'POST', '/api/auth/login', { headers: { origin: BASE }, body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    const cookie = setCookies(login).map(c => c.split(';')[0]).join('; ');
    expect((await call(env, 'GET', '/api/me', { headers: { cookie } })).status).toBe(200);
    const ok = await call(env, 'POST', '/api/domains/bulk-import', { headers: { cookie, origin: BASE }, body: { domains: 'a.example.net' } });
    expect(ok.status).not.toBe(403);
    const cross = await call(env, 'POST', '/api/domains/bulk-import', { headers: { cookie, origin: 'https://evil.example' }, body: { domains: 'b.example.net' } });
    expect(cross.status).toBe(403);
  });

  it('scripts without an Origin still receive a bearer token (and API keys keep working as bearer credentials)', async () => {
    const env = await owner();
    const res = await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    const { token } = await res.json() as { token: string };
    expect(token).toBeTruthy();
    expect((await call(env, 'GET', '/api/me', { key: token })).status).toBe(200);
  });
});
