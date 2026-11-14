// The path from sign-up to a first verified domain, walked before launch (2026-11-13): each friction found there, as the
// server must now behave.
//  1. the password is chosen once, on the page the verification link opens (sign-up asks for the email only);
//  2. the moment a claim is proven, its first DNS read is stored, so the overview shows the real level;
//  3. typing a domain that already has a pending claim resumes it;
//  6. while hosted sign-up is closed, no route creates an account (OAuth included);
//  7. a Verify that finds no record yet says so in a machine-readable way, and the verification email says what happens next.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import { call, ctx, makeEnv, req, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { dohFetch, type Zone } from '../../packages/dns-checks/test/helpers';
import { __resetPreviewCacheForTests } from '../../src/domains/claim-preview';
import { handleApi } from '../../src/api/router';
import { createAuth } from '../../src/auth';
import { VERIFICATION_SUBJECT, verificationEmailText } from '../../src/auth/mail';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;

let zone: Zone;
let dnsCalls: string[];
beforeEach(() => {
  __resetPreviewCacheForTests();
  zone = {};
  dnsCalls = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send }, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const lastLink = () => new URL(((send.mock.calls.at(-1) as any)[0].text as string).match(/https?:\/\/\S+verify-email\S+/)![0]);
  const open = (link: URL) => handleApi(new Request(`https://ia.example.com${link.pathname}${link.search}`, { headers: { 'cf-connecting-ip': '10.9.9.9' } }), env, ctx);
  return { db, env, send, rows, lastLink, open };
}

describe('1. the password is typed once, after the mailbox is proven', () => {
  it('sign-up takes the email only; the link lands on "choose your password", which signs the person in', async () => {
    const w = hosted();
    const res = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'New@Example.com' } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ verification_required: true });
    expect(res.headers.get('set-cookie')).toBeNull();

    const verified = await w.open(w.lastLink());
    expect(verified.status).toBe(302);
    expect(verified.headers.get('location')).toMatch(/^\/#\/welcome\/[0-9a-f]{48}$/);
    expect((verified.headers as any).getSetCookie()).toEqual([]);

    const token = verified.headers.get('location')!.split('/').pop()!;
    const chosen = await call(w.env, 'POST', '/api/auth/reset', { body: { token, password: 'chosen-once-123' } });
    expect(chosen.status).toBe(200);
    const session = (await json(chosen)).token as string;
    expect((await call(w.env, 'GET', '/api/me', { key: session })).status).toBe(200);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'chosen-once-123' } })).status).toBe(200);
  });

  it('nobody can sign in to an account made by sign-up before its link is used: there is no password to know', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com' } });
    const cred = w.rows("SELECT a.password FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE u.email = 'cfo@acme.com' AND a.provider_id = 'credential'");
    expect(cred).toHaveLength(1);
    expect(cred[0].password).toBeTruthy(); // a random one nobody was told
    for (const guess of ['', 'password-123', 'cfo@acme.com']) {
      expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'cfo@acme.com', password: guess } })).status).not.toBe(200);
    }
    expect(w.rows("SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'cfo@acme.com'")).toEqual([{ n: 0 }]);
  });

  it('opening the link again after choosing the password keeps that password (a second click resets nothing)', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const link = w.lastLink();
    const token = (await w.open(link)).headers.get('location')!.split('/').pop()!;
    expect((await call(w.env, 'POST', '/api/auth/reset', { body: { token, password: 'chosen-once-123' } })).status).toBe(200);
    const again = await w.open(link);
    expect(again.headers.get('location') ?? '').not.toMatch(/welcome|reset/);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'chosen-once-123' } })).status).toBe(200);
  });

  it('a hosted invitee is not asked for a password either', async () => {
    const w = hosted();
    const owner = await signupVerified(w.env, 'owner@example.com');
    const inv = await json(await call(w.env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@example.com' } }));
    const res = await call(w.env, 'POST', `/api/invites/${inv.token}`, { body: { name: 'Friend' } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ verification_required: true, invite_pending: true });
    expect((await w.open(w.lastLink())).headers.get('location')).toMatch(/^\/#\/welcome\//);
  });

  it('self-host keeps asking for the password at setup and for an invite', async () => {
    const env = makeEnv(createMigratedD1());
    expect((await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com' } })).status).toBe(400);
  });

  it('the verification email names Ready Set Mail and says what the link does', async () => {
    const w = hosted();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } });
    const sent = (w.send.mock.calls.at(-1) as any)[0];
    expect(sent.from.name).toBe('Ready Set Mail');
    expect(sent.subject).toBe(VERIFICATION_SUBJECT);
    expect(sent.subject).toBe('Confirm your email for Ready Set Mail');
    expect(sent.text).toBe(verificationEmailText(w.lastLink().toString()));
    expect(sent.text).toContain('confirm your email address and choose your Ready Set Mail password');
    expect(sent.text).toContain('You are signed in as soon as you save it');
    expect(sent.text).not.toMatch(/Inbox ?Angel|next page/i);
  });
});

describe('2. the overview has the real level the moment a claim is proven', () => {
  async function claimed() {
    const w = hosted();
    const token = await signupVerified(w.env, 'a@example.com');
    vi.stubGlobal('fetch', dohFetch(zone, dnsCalls));
    const { claim } = await json(await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'acme.com' } }));
    Object.assign(zone, {
      'TXT acme.com': ['v=spf1 include:_spf.google.com ~all'],
      'TXT _spf.google.com': ['v=spf1 ip4:1.2.3.4 ~all'],
      'TXT _dmarc.acme.com': ['v=DMARC1; p=reject; pct=50'],
      [`TXT _readysetmail.acme.com`]: [claim.txt_value],
    });
    const verify = () => call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: token, body: {} });
    const summary = async (id: number) => json(await call(w.env, 'GET', `/api/domains/${id}/check-summary`, { key: token }));
    return { ...w, token, claim, verify, summary };
  }

  it('TXT proof: SPF, its lookup count, the DMARC policy and pct= are stored, checked just now', async () => {
    const w = await claimed();
    const res = await w.verify();
    expect(res.status).toBe(201);
    const { domain } = await json(res);
    const s = await w.summary(domain.id);
    expect(s).toMatchObject({ spf_record: 'v=spf1 include:_spf.google.com ~all', spf_lookup_count: 1, dmarc_policy: 'reject', dmarc_pct: 50, dns_check_status: 'ok' });
    expect(Math.abs(s.dns_checked_at - Date.now() / 1000)).toBeLessThan(60);
  });

  it('costs one snapshot at most, and none when the claim preview read DNS within the minute', async () => {
    const w = await claimed();
    await call(w.env, 'GET', `/api/domains/claims/${w.claim.id}/preview`, { key: w.token });
    dnsCalls.length = 0;
    const { domain } = await json(await w.verify());
    expect(dnsCalls).toEqual(['TXT _readysetmail.acme.com']); // the proof itself, nothing else
    expect(await w.summary(domain.id)).toMatchObject({ dmarc_policy: 'reject', dmarc_pct: 50, spf_lookup_count: 1 });
  });

  it('without a fresh preview it runs the daily job\'s snapshot once', async () => {
    const w = await claimed();
    dnsCalls.length = 0;
    await w.verify();
    expect(dnsCalls.filter(c => c === 'TXT acme.com')).toHaveLength(1);
    expect(dnsCalls.filter(c => c === 'TXT _dmarc.acme.com')).toHaveLength(1);
  });

  it('a lookup that fails stores nothing: "not checked yet", never a missing record and never "last check failed"', async () => {
    const w = await claimed();
    zone['TXT _dmarc.acme.com'] = 'SERVFAIL';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await w.verify();
    expect(res.status).toBe(201); // the proof still succeeds
    const s = await w.summary((await json(res)).domain.id);
    expect(s).toMatchObject({ dns_checked_at: null, dns_check_status: null, dmarc_policy: null, spf_record: null });
  });
});

describe('3. typing a domain that already has a pending claim resumes it', () => {
  it('the wizard and the add form both answer with the same claim, and no second one is made', async () => {
    const w = hosted();
    const token = await signupVerified(w.env, 'a@example.com');
    const first = await json(await call(w.env, 'POST', '/api/settings/base-domain', { key: token, body: { domain: 'acme.com' } }));
    const again = await call(w.env, 'POST', '/api/settings/base-domain', { key: token, body: { domain: 'ACME.com' } });
    expect(again.status).toBe(202);
    expect((await json(again)).claim).toMatchObject({ id: first.claim.id, txt_value: first.claim.txt_value });
    const viaAdd = await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'acme.com' } });
    expect(viaAdd.status).toBe(202);
    expect((await json(viaAdd)).claim.id).toBe(first.claim.id);
    expect(w.rows('SELECT COUNT(*) n FROM domain_claims')).toEqual([{ n: 1 }]);
    expect((await json(await call(w.env, 'GET', '/api/domains', { key: token }))).pending_claims).toMatchObject([{ id: first.claim.id, status: 'pending' }]);
  });
});

describe('6. hosted sign-up closed: no account is created by any route', () => {
  const closedEnvs = () => [
    hosted({ TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined, GITHUB_CLIENT_ID: 'g', GITHUB_CLIENT_SECRET: 's' }),
    hosted({ TURNSTILE_SITE_KEY: undefined, GITHUB_CLIENT_ID: 'g', GITHUB_CLIENT_SECRET: 's' }), // a secret alone is not enough: the page cannot show the check
  ];

  it('the status says closed and offers no OAuth provider, and an OAuth start is refused', async () => {
    for (const w of closedEnvs()) {
      const status = await json(await call(w.env, 'GET', '/api/auth/status'));
      expect(status).toMatchObject({ signup_open: false, signin_available: false, oauth_providers: [] });
      const social = await call(w.env, 'POST', '/api/auth/sign-in/social', { body: { provider: 'github', callbackURL: '/' } });
      expect(social.status).toBe(503);
      expect((await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com' } })).status).toBe(503);
    }
  });

  it('an OAuth callback for a new address creates no user', async () => {
    for (const w of closedEnvs()) {
      const auth = await createAuth(w.env as any, req('GET', '/api/auth/status'));
      const res = await handleOAuthUserInfo({ context: await (auth as any).$context, request: undefined } as any, {
        userInfo: { id: 'gh-1', email: 'new@example.com', name: 'New', emailVerified: true },
        account: { providerId: 'github', accountId: 'gh-1', accessToken: 'at' },
        callbackURL: '/',
      } as any).catch((e: unknown) => ({ error: e }));
      expect(res.error).toBeTruthy(); // the user-creation hook refuses (Better Auth surfaces it as an error)
      expect(w.rows('SELECT COUNT(*) n FROM users')).toEqual([{ n: 0 }]);
    }
  });

  it('an invite link creates no account while closed', async () => {
    const open = hosted();
    const owner = await signupVerified(open.env, 'owner@example.com');
    const inv = await json(await call(open.env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@example.com' } }));
    const closed = { ...open.env, TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } as typeof open.env;
    const res = await call(closed, 'POST', `/api/invites/${inv.token}`, { body: { name: 'Friend' } });
    expect(res.status).toBe(503);
    expect(open.rows("SELECT COUNT(*) n FROM users WHERE email = 'friend@example.com'")).toEqual([{ n: 0 }]);
  });

  it('open (both keys set): the same OAuth callback still creates the account', async () => {
    const w = hosted({ GITHUB_CLIENT_ID: 'g', GITHUB_CLIENT_SECRET: 's' });
    const auth = await createAuth(w.env as any, req('GET', '/api/auth/status'));
    const res = await handleOAuthUserInfo({ context: await (auth as any).$context, request: undefined } as any, {
      userInfo: { id: 'gh-2', email: 'new@example.com', name: 'New', emailVerified: true },
      account: { providerId: 'github', accountId: 'gh-2', accessToken: 'at' },
      callbackURL: '/',
    } as any);
    expect(res.error).toBeFalsy();
    expect(w.rows("SELECT COUNT(*) n FROM users WHERE email = 'new@example.com'")).toEqual([{ n: 1 }]);
  });
});

describe('7. Verify before the record is visible', () => {
  it('answers 422 with code not_found_yet, keeps the claim pending, and can be pressed again at once', async () => {
    const w = hosted();
    const token = await signupVerified(w.env, 'a@example.com');
    vi.stubGlobal('fetch', dohFetch(zone, dnsCalls));
    const { claim } = await json(await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'acme.com' } }));
    for (let i = 0; i < 5; i++) {
      const res = await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: token, body: {} });
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({ verified: false, code: 'not_found_yet', claim: { status: 'pending' } });
    }
    zone['TXT _readysetmail.acme.com'] = [claim.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: token, body: {} })).status).toBe(201);
  });

  it('a lookup that failed is lookup_failed, not "not found"', async () => {
    const w = hosted();
    const token = await signupVerified(w.env, 'a@example.com');
    vi.stubGlobal('fetch', dohFetch(zone, dnsCalls));
    const { claim } = await json(await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'acme.com' } }));
    zone['TXT _readysetmail.acme.com'] = 'SERVFAIL';
    const res = await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: token, body: {} });
    expect(await json(res)).toMatchObject({ code: 'lookup_failed' });
  });
});
