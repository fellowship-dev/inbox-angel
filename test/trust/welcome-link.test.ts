// The hosted verification link (src/auth/welcome.ts): opening it changes nothing; the welcome page's POST verifies the
// address and sets the password in one step, once. A mail scanner that fetches the link cannot use up the person's click.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { signJWT } from 'better-auth/crypto';
import { call, completeWelcome, ctx, makeEnv, welcomeTokenIn } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { handleApi } from '../../src/api/router';
import { authSecret } from '../../src/auth/secret';
import { VERIFICATION_LINK_SECONDS } from '../../src/auth/welcome';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;
afterEach(() => vi.restoreAllMocks());

const ORIGIN = 'https://ia.example.com';

function hosted() {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send } });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const mails = () => send.mock.calls.map(c => (c as any)[0] as { to: string[]; text: string });
  const lastToken = () => welcomeTokenIn(mails().at(-1)!.text);
  /** Everything a GET could change. */
  const state = () => rows('SELECT u.email_verified, a.password, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions FROM users u JOIN auth_accounts a ON a.user_id = u.id ORDER BY u.email');
  return { db, env, send, rows, mails, lastToken, state };
}

/** A client fetching the old-style link (what a scanner or preview bot does with whatever URL it finds). */
const fetchLegacyLink = (env: any, token: string, ua: string) =>
  handleApi(new Request(`${ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`, { headers: { 'user-agent': ua, 'cf-connecting-ip': '198.51.100.7' } }), env, ctx);

describe('the emailed link', () => {
  it('carries the token in the URL fragment, which no server receives', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const link = w.mails()[0]!.text.match(/https:\/\/\S+/)![0];
    const url = new URL(link);
    expect(url.origin + url.pathname + url.search).toBe(`${ORIGIN}/`); // what a request for this link sends
    expect(url.hash).toMatch(/^#\/welcome\/[A-Za-z0-9._-]+$/);
  });

  it('a scanner fetching the link (any number of times, any client) changes nothing; the real click still works', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    const before = w.state();
    for (const ua of ['Mimecast-Scanner/1.0', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (preview)']) {
      const res = await fetchLegacyLink(w.env, token, ua);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect((res.headers as any).getSetCookie()).toEqual([]);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'; script-src 'sha256-/);
      const html = await res.text();
      expect(html).not.toContain(token); // the page moves the token from its own URL into the fragment; it does not echo it
      expect(html).toContain("location.replace('/#/welcome/'");
    }
    expect(w.state()).toEqual(before);
    const real = await completeWelcome(w.env, token, 'the-real-person-1');
    expect(real.status).toBe(200);
    expect((await json(real)).token).toBeTruthy();
  });

  it('two GETs from different clients, then one POST: signed in', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    await fetchLegacyLink(w.env, token, 'scanner-a');
    await fetchLegacyLink(w.env, token, 'scanner-b');
    expect((await completeWelcome(w.env, token, 'chosen-password-1', { ip: '203.0.113.9' })).status).toBe(200);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'chosen-password-1' } })).status).toBe(200);
  });

  it('POST twice: the second is refused (link_used) and the first password stands', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    expect((await completeWelcome(w.env, token, 'first-password-1')).status).toBe(200);
    const again = await completeWelcome(w.env, token, 'second-password-1');
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'link_used' });
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'first-password-1' } })).status).toBe(200);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'second-password-1' } })).status).toBe(401);
  });

  it('two simultaneous POSTs of one token: exactly one wins', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    const results = await Promise.all([completeWelcome(w.env, token, 'racer-one-pass-1'), completeWelcome(w.env, token, 'racer-two-pass-2')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('a wrong, tampered or expired token is refused and changes nothing', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    const before = w.state();
    const wrong = await completeWelcome(w.env, 'not-a-token-at-all-000000', 'password-123');
    expect(wrong.status).toBe(400);
    expect(await json(wrong)).toMatchObject({ code: 'link_invalid' });
    const [h, p] = token.split('.');
    const forged = `${h}.${p}.${'A'.repeat(43)}`;
    expect(await json(await completeWelcome(w.env, forged, 'password-123'))).toMatchObject({ code: 'link_invalid' });
    const secret = await authSecret(w.env as any);
    const expired = await signJWT({ email: 'a@example.com' }, secret, -60);
    const old = await completeWelcome(w.env, expired, 'password-123');
    expect(old.status).toBe(410);
    expect(await json(old)).toMatchObject({ code: 'link_expired' });
    expect(w.state()).toEqual(before);
  });

  it('works for its whole stated lifetime (24 hours), one number everywhere', async () => {
    expect(VERIFICATION_LINK_SECONDS).toBe(24 * 3600);
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    const exp = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).exp as number;
    expect(Math.abs(exp - (Date.now() / 1000 + VERIFICATION_LINK_SECONDS))).toBeLessThan(60);
    expect(w.mails()[0]!.text).toContain('for 24 hours');
  });

  it('is rate limited per token (10 an hour)', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const token = w.lastToken();
    let last = 0; // ten wrong guesses at one token get "not valid"; the eleventh is not even checked
    for (let i = 0; i < 11; i++) last = (await completeWelcome(w.env, `${token}x`, 'long-enough-1')).status;
    expect(last).toBe(429);
  });
});

describe('a pre-registered address: the real owner ends up with an account the registrant has nothing in', () => {
  it('the registrant\'s password dies, their sessions end, and they could create nothing before', async () => {
    const w = hosted();
    // the attacker registers the CFO's address with a password they know, and has a session row (as if issued somehow)
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com', password: 'attacker-password-1', name: 'Attacker' } });
    const uid = w.rows("SELECT id FROM users WHERE email = 'cfo@acme.com'")[0].id as string;
    const ws = w.rows('SELECT workspace_id FROM memberships WHERE user_id = ?', uid)[0].workspace_id as string;
    w.db.sqlite.prepare("INSERT INTO sessions (id, user_id, token, expires_at) VALUES ('s1', ?, 'attacker-session', 9999999999)").run(uid);
    // before verification the attacker can do nothing with that account
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'cfo@acme.com', password: 'attacker-password-1' } })).status).toBe(403);
    for (const [method, path, body] of [
      ['POST', '/api/domains', { domain: 'acme.com' }],
      ['POST', '/api/settings/base-domain', { domain: 'acme.com' }],
      ['POST', '/api/team/invite', { email: 'accomplice@evil.example' }],
      ['POST', '/api/keys', { name: 'k' }],
      ['GET', '/api/domains', undefined],
    ] as const) {
      const res = await call(w.env, method, path, { key: 'attacker-session', ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    // the real CFO opens the mail they received and chooses a password
    const res = await completeWelcome(w.env, w.lastToken(), 'cfo-own-password-1');
    expect(res.status).toBe(200);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'cfo@acme.com', password: 'attacker-password-1' } })).status).toBe(401);
    expect(w.rows("SELECT COUNT(*) n FROM sessions WHERE token = 'attacker-session'")).toEqual([{ n: 0 }]);
    expect((await call(w.env, 'GET', '/api/me', { key: 'attacker-session' })).status).toBe(401);
    // nothing of the attacker's in the workspace
    for (const table of ['domains', 'domain_claims', 'invites', 'api_keys', 'access_principals', 'access_grants', 'access_credentials']) {
      expect(w.rows(`SELECT COUNT(*) n FROM ${table} WHERE workspace_id = ?`, ws), table).toEqual([{ n: 0 }]);
    }
    expect(w.rows('SELECT COUNT(*) n FROM memberships WHERE workspace_id = ?', ws)).toEqual([{ n: 1 }]); // the CFO only
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'cfo@acme.com', password: 'cfo-own-password-1' } })).status).toBe(200);
  });
});

describe('verification mail is capped per address, across every route, without revealing whether the address exists', () => {
  it('resends and sign-ins of the unconfirmed account share 3 an hour; the 4th sends nothing, and every answer is unchanged (sign-up has its own allowance: signup-hardening.test.ts)', async () => {
    const w = hosted();
    const ip = (n: number) => ({ ip: `192.0.2.${n}` });
    const signup = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'api-client-pass-1' }, ...ip(1) }); // the sign-up allowance
    expect(signup.status).toBe(201);
    expect((await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com' }, ...ip(2) })).status).toBe(200); // 1
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'api-client-pass-1' }, ...ip(3) })).status).toBe(403); // 2 (sign-in of an unverified account mails a link)
    expect((await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com' }, ...ip(4) })).status).toBe(200); // 3
    expect(w.send).toHaveBeenCalledTimes(4);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capped = await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com' }, ...ip(5) });
    const unknown = await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'nobody@example.com' }, ...ip(6) });
    expect([capped.status, await json(capped)]).toEqual([unknown.status, await json(unknown)]);
    const login = await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'api-client-pass-1' }, ...ip(7) });
    expect(login.status).toBe(403); // same answer as when a mail is sent
    expect(w.send).toHaveBeenCalledTimes(4);
  }, 30000);

  it('10 a day', async () => {
    const w = hosted();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const t0 = Date.now();
    for (let hour = 0; hour < 5; hour++) {
      vi.spyOn(Date, 'now').mockReturnValue(t0 + hour * 3601_000);
      for (let i = 0; i < 3; i++) await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com' }, ip: `192.0.2.${hour * 3 + i + 10}` });
    }
    expect(w.send).toHaveBeenCalledTimes(1 + 10); // the sign-up's own link, then 10 resends a day
  }, 30000);
});
