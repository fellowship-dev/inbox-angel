// Before public sign-up opens: the mail allowance cannot be spent to deny a person their own link; sign-in failures are
// throttled per address; names typed before an address was proven do not survive it; one pct= refresh per domain.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, completeWelcome, ctx, makeEnv, signupVerified, welcomeTokenIn } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { dohFetch, type Zone } from '../../packages/dns-checks/test/helpers';
import { MAIL_CAPS, SIGNIN_FAILURE_LIMIT, SIGNIN_FAILURE_WINDOW_SECONDS } from '../../src/auth/welcome';
import { cleanName } from '../../src/auth/names';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send }, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const sentTo = (email: string) => send.mock.calls.filter(c => ((c as any)[0].to as string[]).includes(email)).length;
  const lastToken = () => welcomeTokenIn((send.mock.calls.at(-1) as any)[0].text);
  return { db, env, send, rows, sentTo, lastToken };
}
let n = 0;
const ip = () => ({ ip: `198.51.100.${++n % 250}` });

describe('1. resend needs the bot check, and a resend flood cannot use up the link a sign-up sends', () => {
  it('resend without a solved bot check is refused; with one it answers ok; when sign-up is closed it is closed too', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' }, ...ip() });
    expect((await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com', cf_turnstile_token: '' }, ...ip() })).status).toBe(403);
    expect((await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com', cf_turnstile_token: 'bad' }, ...ip() })).status).toBe(403);
    expect((await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com', cf_turnstile_token: 'ok' }, ...ip() })).status).toBe(200);
    const closed = { ...w.env, TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } as typeof w.env;
    expect((await call(closed, 'POST', '/api/auth/resend-verification', { body: { email: 'a@example.com' }, ...ip() })).status).toBe(503);
  });

  it('an attacker registers the victim, floods resend; the victim\'s own sign-up still sends their link, and answers identically throughout', async () => {
    const w = hosted();
    const first = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'victim@example.com' }, ...ip() }); // the attacker, past one bot check
    expect(w.sentTo('victim@example.com')).toBe(1);
    for (let i = 0; i < 12; i++) {
      const r = await call(w.env, 'POST', '/api/auth/resend-verification', { body: { email: 'victim@example.com', cf_turnstile_token: 'ok' }, ...ip() });
      expect(await json(r)).toEqual({ ok: true });
    }
    expect(w.sentTo('victim@example.com')).toBe(1 + MAIL_CAPS.other.hour); // the resend allowance, then nothing
    // the victim signs up themselves: a fresh link arrives from the sign-up allowance
    const waits = (ctx.waitUntil as any).mock.calls.length;
    const own = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'victim@example.com' }, ...ip() });
    await Promise.all((ctx.waitUntil as any).mock.calls.slice(waits).map((c: any[]) => c[0])); // the link is sent in the background
    expect(own.status).toBe(first.status);
    expect(await json(own)).toEqual(await json(first));
    expect(w.sentTo('victim@example.com')).toBe(2 + MAIL_CAPS.other.hour);
    expect((await completeWelcome(w.env, w.lastToken(), 'victims-own-pass-1')).status).toBe(200);
  }, 30000);

  it('repeated sign-ups cannot flood: 2 an hour and 4 a day from the sign-up allowance, every answer the same', async () => {
    expect(MAIL_CAPS).toEqual({ signup: { hour: 2, day: 4 }, other: { hour: 3, day: 10 } });
    const w = hosted();
    const t0 = Date.now();
    const bodies = new Set<string>();
    for (let hour = 0; hour < 4; hour++) {
      vi.spyOn(Date, 'now').mockReturnValue(t0 + hour * 3601_000);
      for (let i = 0; i < 3; i++) bodies.add(JSON.stringify(await json(await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'v@example.com' }, ...ip() }))));
    }
    await Promise.all((ctx.waitUntil as any).mock.calls.map((c: any[]) => c[0])); // background sends finished
    expect(bodies.size).toBe(1);
    expect(w.sentTo('v@example.com')).toBe(4);
  }, 30000);
});

describe('2. sign-in failures are throttled per address', () => {
  it('10 failures in 15 minutes from 10 addresses: the next try waits, with a Retry-After, even with the right password; same for an address with no account', async () => {
    const w = hosted();
    await signupVerified(w.env, 'real@example.com', 'right-password-1');
    for (const email of ['real@example.com', 'nobody@example.com']) {
      for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) {
        expect((await call(w.env, 'POST', '/api/auth/login', { body: { email, password: `wrong-${i}-password` }, ...ip() })).status).toBe(401);
      }
    }
    const real = await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'right-password-1' }, ...ip() });
    const nobody = await call(w.env, 'POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'anything-at-all' }, ...ip() });
    for (const r of [real, nobody]) {
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(SIGNIN_FAILURE_WINDOW_SECONDS - 60);
    }
    const [realBody, nobodyBody] = [await json(real), await json(nobody)];
    expect(realBody).toEqual(nobodyBody);
    expect(realBody.error).toBe('Too many sign-in attempts for this address. Try again in 15 minutes, or reset your password to sign in now.');
    // other addresses are unaffected
    await signupVerified(w.env, 'other@example.com', 'other-password-1');
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'other@example.com', password: 'other-password-1' }, ...ip() })).status).toBe(200);
  }, 30000);

  it('the window is short: 15 minutes later the right password works again', async () => {
    const w = hosted();
    await signupVerified(w.env, 'real@example.com', 'right-password-1');
    const t0 = Date.now();
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'wrong-password-x' }, ...ip() });
    vi.spyOn(Date, 'now').mockReturnValue(t0 + SIGNIN_FAILURE_WINDOW_SECONDS * 1000 + 1000);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'right-password-1' }, ...ip() })).status).toBe(200);
  });

  it('a password reset clears it at once', async () => {
    const w = hosted();
    await signupVerified(w.env, 'real@example.com', 'right-password-1');
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'wrong-password-x' }, ...ip() });
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'right-password-1' }, ...ip() })).status).toBe(429);
    await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'real@example.com' }, ...ip() });
    const link = ((w.send.mock.calls.at(-1) as any)[0].text as string).match(/#\/reset\/([A-Za-z0-9_-]+)/)![1];
    expect((await call(w.env, 'POST', '/api/auth/reset', { body: { token: link, password: 'new-password-123' }, ...ip() })).status).toBe(200);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'new-password-123' }, ...ip() })).status).toBe(200);
  });

  it('applies whether or not the bot check is configured', async () => {
    const w = hosted();
    await signupVerified(w.env, 'real@example.com', 'right-password-1');
    const closed = { ...w.env, TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } as typeof w.env;
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) await call(closed, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'wrong-password-x' }, ...ip() });
    expect((await call(closed, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'right-password-1' }, ...ip() })).status).toBe(429);
  });
});

describe('3. names typed before the address was proven do not survive it', () => {
  const planted = 'Support: call +1 555 0100';

  it('sign-up ignores a submitted name; the workspace starts from the email\'s domain', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com', name: planted }, ...ip() });
    expect(w.rows("SELECT name FROM users WHERE email = 'cfo@acme.com'")).toEqual([{ name: 'cfo@acme.com' }]);
    expect(w.rows("SELECT w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id WHERE u.email = 'cfo@acme.com'")).toEqual([{ name: 'acme.com workspace' }]);
  });

  it('at verification the display name and the sign-up workspace are reset (planted text gone), or set from the welcome page\'s name', async () => {
    for (const [given, name, workspace] of [['', 'cfo@acme.com', 'acme.com workspace'], ['Cleo Fox', 'Cleo Fox', "Cleo Fox's workspace"]] as const) {
      const w = hosted();
      await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com' }, ...ip() });
      // a name planted before verification (an older account, or any other route)
      w.db.sqlite.prepare("UPDATE users SET name = ? WHERE email = 'cfo@acme.com'").run(planted);
      w.db.sqlite.prepare("UPDATE workspaces SET name = ? WHERE id IN (SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'cfo@acme.com')").run(planted);
      expect((await call(w.env, 'POST', '/api/auth/welcome', { body: { token: w.lastToken(), password: 'cfo-own-pass-1', ...(given ? { name: given } : {}) }, ...ip() })).status).toBe(200);
      expect(w.rows("SELECT name FROM users WHERE email = 'cfo@acme.com'")).toEqual([{ name }]);
      expect(w.rows("SELECT w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id WHERE u.email = 'cfo@acme.com'")).toEqual([{ name: workspace }]);
    }
  });

  it('a hosted invitee gives no name before verifying; the welcome page\'s name is used, and the inviting workspace keeps its name', async () => {
    const w = hosted();
    const owner = await signupVerified(w.env, 'owner@example.com');
    const inv = await json(await call(w.env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@example.com' } }));
    const before = w.rows('SELECT name FROM workspaces WHERE id = (SELECT workspace_id FROM invites)');
    expect((await call(w.env, 'POST', `/api/invites/${inv.token}`, { body: { name: planted }, ...ip() })).status).toBe(201);
    expect(w.rows("SELECT name FROM users WHERE email = 'friend@example.com'")).toEqual([{ name: 'friend@example.com' }]);
    await call(w.env, 'POST', '/api/auth/welcome', { body: { token: w.lastToken(), password: 'friend-pass-123', name: 'Sam' }, ...ip() });
    expect(w.rows("SELECT name FROM users WHERE email = 'friend@example.com'")).toEqual([{ name: 'Sam' }]);
    expect(w.rows('SELECT name FROM workspaces WHERE id = (SELECT workspace_id FROM invites)')).toEqual(before);
  });

  it('names are stored clean: control and invisible characters removed, 80 characters at most', async () => {
    expect(cleanName('A‮evil\u0000 ​name\n\tx')).toBe('A evil name x');
    expect([...cleanName('x'.repeat(200))]).toHaveLength(80);
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' }, ...ip() });
    await call(w.env, 'POST', '/api/auth/welcome', { body: { token: w.lastToken(), password: 'a-own-pass-123', name: 'Ann‮\u0007' }, ...ip() });
    expect(w.rows("SELECT name FROM users WHERE email = 'a@example.com'")).toEqual([{ name: 'Ann' }]);
    const session = (await json(await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'a-own-pass-123' }, ...ip() }))).token;
    const made = await json(await call(w.env, 'POST', '/api/workspaces', { key: session, body: { name: 'Client​‮ Co\r\n' } }));
    expect(made.name).toBe('Client Co');
  });
});

describe('one pct= refresh per domain, however many views at once', () => {
  it('five parallel views start one snapshot', async () => {
    const w = hosted();
    const token = await signupVerified(w.env, 'a@example.com');
    const ws = w.rows("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'a@example.com'")[0].workspace_id;
    const checked = Math.floor(Date.now() / 1000) - 86400;
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via, dmarc_policy, spf_record, dns_checked_at, dns_check_attempted_at, dns_check_status, dns_last_good_status) VALUES ('acme.com', '', ?, 'txt', 'reject', 'v=spf1 -all', ?, ?, 'ok', 'ok')").run(ws, checked, checked);
    const id = w.rows("SELECT id FROM domains WHERE domain = 'acme.com'")[0].id;
    const zone: Zone = { 'TXT acme.com': ['v=spf1 -all'], 'TXT _dmarc.acme.com': ['v=DMARC1; p=reject'] };
    const calls: string[] = [];
    // DNS answers take a moment, as they do for real, so the five views genuinely overlap
    const doh = dohFetch(zone, calls);
    vi.stubGlobal('fetch', async (u: string) => { await new Promise(r => setTimeout(r, 25)); return doh(u); });
    const waits = (ctx.waitUntil as any).mock.calls.length;
    await Promise.all(Array.from({ length: 5 }, () => call(w.env, 'GET', `/api/domains/${id}/check-summary`, { key: token })));
    const started = (ctx.waitUntil as any).mock.calls.slice(waits).map((c: any[]) => c[0]);
    await Promise.all(started);
    expect(calls.filter(c => c === 'TXT _dmarc.acme.com')).toHaveLength(1);
    expect(w.rows('SELECT dmarc_pct FROM domains WHERE id = ?', id)).toEqual([{ dmarc_pct: 100 }]);
  });
});

describe('review follow-ups', () => {
  it('a device that signed in to this account before skips the per-address lock; strangers, other accounts and forged cookies do not', async () => {
    const w = hosted();
    await signupVerified(w.env, 'real@example.com', 'right-password-1');
    const first = await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'right-password-1' }, ...ip() });
    const device = ((first.headers as any).getSetCookie() as string[]).find(c => c.startsWith('rsm_device='))!;
    expect(device).toMatch(/HttpOnly/);
    expect(device).toMatch(/SameSite=Lax/);
    expect(device).toMatch(/Max-Age=15552000/);
    const cookie = device.split(';')[0]!;
    await signupVerified(w.env, 'other@example.com', 'other-password-1');
    const otherDevice = ((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'other@example.com', password: 'other-password-1' }, ...ip() })).headers as any).getSetCookie().find((c: string) => c.startsWith('rsm_device=')).split(';')[0];
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) await call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'wrong-password-x' }, ...ip() });
    const login = (headers: Record<string, string> = {}) => call(w.env, 'POST', '/api/auth/login', { body: { email: 'real@example.com', password: 'right-password-1' }, headers, ...ip() });
    expect((await login()).status).toBe(429);
    expect((await login({ cookie: otherDevice })).status).toBe(429);
    expect((await login({ cookie: cookie.slice(0, -2) + 'xx' })).status).toBe(429);
    expect((await login({ cookie })).status).toBe(200);
  });

  it('expired rate-limit rows are swept in bounded batches, recent ones kept', async () => {
    const { sweepExpiredRateLimits, d1RateLimitStorage, SWEEP_BATCH } = await import('../../src/auth/rate-limit');
    const w = hosted();
    const now = Date.now();
    const ins = w.db.sqlite.prepare('INSERT INTO auth_rate_limits (id, key, count, last_request) VALUES (?, ?, 1, ?)');
    for (let i = 0; i < SWEEP_BATCH + 50; i++) ins.run(`old-${i}`, `signin-fail:old-${i}`, now - 3 * 86_400_000);
    ins.run('fresh', 'signin-fail:fresh', now - 3_600_000);
    expect(await sweepExpiredRateLimits(w.env.DB as any, now)).toBe(SWEEP_BATCH);
    expect(w.rows("SELECT COUNT(*) n FROM auth_rate_limits WHERE id LIKE 'old-%'")).toEqual([{ n: 50 }]);
    // a write sweeps on its own now and then (forced here)
    await d1RateLimitStorage(w.env.DB as any, () => 0).consume('some-key', { window: 60, max: 5 });
    expect(w.rows("SELECT COUNT(*) n FROM auth_rate_limits WHERE id LIKE 'old-%'")).toEqual([{ n: 0 }]);
    expect(w.rows("SELECT COUNT(*) n FROM auth_rate_limits WHERE id = 'fresh'")).toEqual([{ n: 1 }]);
  });

  it('a free-mail address starts with "My workspace", a company address with "<domain> workspace"', async () => {
    const w = hosted();
    for (const email of ['someone@gmail.com', 'cfo@acme.com']) await call(w.env, 'POST', '/api/auth/signup', { body: { email }, ...ip() });
    const name = (email: string) => w.rows('SELECT w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].name;
    expect(name('someone@gmail.com')).toBe('My workspace');
    expect(name('cfo@acme.com')).toBe('acme.com workspace');
  });
});
