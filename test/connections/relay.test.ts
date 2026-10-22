import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleRelay, relayEnabled, RELAY_STATE_TTL_SECONDS } from '../../src/connections/relay';
import worker from '../../src/index';
import { b64url } from '../../src/connections/crypto';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { FakeCloudflare } from '../helpers/cf-fake';
import { AUTH, MockAuthServer } from './mock-oauth';
import { KEY } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const SECRET = 'relay-signing-secret-for-tests';
const RELAY = 'https://connect.mock.test';
const ENV = { ...AUTH, CF_OAUTH_RELAY_SECRET: SECRET };
const CHALLENGE = 'A'.repeat(43);
const CB = 'https://ia.example.com/api/cloudflare/oauth/callback';
const NOW = 1_800_000_000;

const relay = (path: string, env: Record<string, unknown> = ENV, now = NOW, base = RELAY, init?: RequestInit) =>
  handleRelay(new Request(`${base}${path}`, init), env, now);
const startPath = (over: Record<string, string> = {}) => `/relay/start?${new URLSearchParams({ cb: CB, state: 'INSTANCE.STATE', challenge: CHALLENGE, ...over })}`;

/** The relay's signed state, minted with the relay secret (for forging cases the relay itself would never create). */
async function mint(payload: object, secret = SECRET): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))))}`;
}

beforeEach(() => {
  for (const m of ['warn', 'log', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('relay: /relay/start', () => {
  it('wraps the instance state in its own signed state and sends the browser to Cloudflare', async () => {
    const res = await relay(startPath());
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(AUTH.CF_OAUTH_AUTHORIZE_URL);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'ia-test-client', redirect_uri: `${RELAY}/relay/callback`, scope: 'zone:read dns:edit',
      code_challenge: CHALLENGE, code_challenge_method: 'S256',
    });
    const relayState = to.searchParams.get('state')!;
    expect(relayState).not.toBe('INSTANCE.STATE');
    expect(relayState.split('.')).toHaveLength(2);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('refuses a callback that is not https, one with credentials, a bad challenge, and plain-http access to the relay', async () => {
    expect((await relay(startPath({ cb: 'http://ia.example.com/cb' }))).status).toBe(400);
    expect((await relay(startPath({ cb: 'https://user:pw@ia.example.com/cb' }))).status).toBe(400);
    expect((await relay(startPath({ cb: 'javascript:alert(1)' }))).status).toBe(400);
    expect((await relay(startPath({ cb: '' }))).status).toBe(400);
    expect((await relay(startPath({ challenge: 'short' }))).status).toBe(400);
    expect((await relay(startPath(), ENV, NOW, 'http://connect.mock.test')).status).toBe(400);
    expect((await relay(startPath(), ENV, NOW, RELAY, { method: 'POST' })).status).toBe(405);
  });

  it('can be limited to one callback path', async () => {
    const env = { ...ENV, CF_OAUTH_RELAY_CALLBACK_PATH: '/api/cloudflare/oauth/callback' };
    expect((await relay(startPath(), env)).status).toBe(302);
    expect((await relay(startPath({ cb: 'https://ia.example.com/elsewhere' }), env)).status).toBe(400);
  });

  it('is unavailable (503) when OAuth is not configured', async () => {
    expect((await relay(startPath(), { CF_OAUTH_RELAY_SECRET: SECRET })).status).toBe(503);
  });
});

/** Complete the confirmation page the way a browser does: same cookie, the form's hidden fields. */
async function page(env: Record<string, unknown>, state: string, code = 'CODE-123', now = NOW) {
  const res = await relay(`/relay/callback?${new URLSearchParams({ code, state })}`, env, now);
  const html = res.status === 200 ? await res.text() : '';
  const field = (n: string) => html.match(new RegExp(`name="${n}" value="([^"]*)"`))?.[1] ?? '';
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const post = (over: Record<string, string> = {}, c = cookie, at = now, base = RELAY) =>
    relay('/relay/confirm', env, at, base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(c ? { cookie: c } : {}) },
      body: new URLSearchParams({ state: field('state'), code: field('code'), nonce: field('nonce'), token: field('token'), ...over }),
    });
  return { res, html, cookie, field, post };
}

describe('relay: /relay/callback (confirmation page)', () => {
  async function stateFromStart(now = NOW, env: Record<string, unknown> = ENV) {
    const to = new URL((await relay(startPath(), env, now)).headers.get('location')!);
    return to.searchParams.get('state')!;
  }

  it('does not forward the code: it shows a page naming the destination host with a Continue button', async () => {
    const state = await stateFromStart();
    const { res, html } = await page(ENV, state);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict; Secure/);
    expect(html).toContain('Continue to ia.example.com');
    expect(html).toContain('<form method="post" action="/relay/confirm">');
    expect(html).toContain('Destination: https://ia.example.com');
  });

  it('forwards only after the explicit confirmation, and then only the code and the instance\'s own state', async () => {
    const state = await stateFromStart();
    const p = await page(ENV, state, 'CODE-123');
    const res = await p.post();
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(CB);
    expect(Object.fromEntries(to.searchParams)).toEqual({ code: 'CODE-123', state: 'INSTANCE.STATE' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('shows an attacker-chosen host as such (HTML-escaped, punycode visible), so the victim can see it is not theirs', async () => {
    const evil = 'https://xn--pple-43d.example/cb';
    const to = new URL((await relay(startPath({ cb: evil }))).headers.get('location')!);
    const { html } = await page(ENV, to.searchParams.get('state')!);
    expect(html).toContain('Continue to xn--pple-43d.example');
    const injected = await mint({ v: 1, cb: 'https://x.example/<script>alert(1)</script>', s: 's', e: NOW + 600 });
    const r = await relay(`/relay/callback?${new URLSearchParams({ code: 'c', state: injected })}`);
    expect(await r.text()).not.toContain('<script>');
  });

  it('refuses a confirmation without the page\'s cookie, with a forged or reused-for-another-code token, or for another state', async () => {
    const state = await stateFromStart();
    const p = await page(ENV, state, 'CODE-123');
    expect((await p.post({}, '')).status).toBe(400);
    expect((await p.post({}, 'ia_relay_confirm=other')).status).toBe(400);
    expect((await p.post({ token: 'AAAA' })).status).toBe(400);
    expect((await p.post({ code: 'CODE-ATTACKER' })).status).toBe(400); // token is bound to the code
    const other = await stateFromStart(NOW + 1);
    expect((await p.post({ state: other })).status).toBe(400); // and to the state
    expect((await p.post({}, p.cookie, NOW + RELAY_STATE_TTL_SECONDS)).status).toBe(400); // expired
    expect((await p.post({}, p.cookie, NOW, 'http://connect.mock.test')).status).toBe(400); // plain http
    expect((await relay('/relay/confirm')).status).toBe(405); // GET never confirms
    for (const r of [await p.post({}, '')]) expect(r.headers.get('location')).toBeNull();
  });

  it('forwards a refusal (error code only: it carries no authorization)', async () => {
    const state = await stateFromStart();
    const res = await relay(`/relay/callback?${new URLSearchParams({ error: 'access_denied', error_description: '<script>', state })}`);
    expect(res.status).toBe(302);
    expect(Object.fromEntries(new URL(res.headers.get('location')!).searchParams)).toEqual({ error: 'access_denied', state: 'INSTANCE.STATE' });
  });

  it('answers 400 to a tampered, forged, truncated or foreign-signed state, and never shows the page or redirects', async () => {
    const state = await stateFromStart();
    const [body, sig] = state.split('.');
    const forgedBody = b64url(new TextEncoder().encode(JSON.stringify({ v: 1, cb: 'https://evil.test/steal', s: 'x', e: NOW + 600 })));
    const bad = [
      `${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}.${sig}`,
      `${forgedBody}.${sig}`,
      `${body}.${sig.slice(0, -3)}AAA`,
      body,
      `${body}.${sig}.extra`,
      '',
      await mint({ v: 1, cb: CB, s: 'x', e: NOW + 600 }, 'some-other-secret'),
    ];
    for (const s of bad) {
      const res = await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-123', state: s })}`);
      expect(res.status, s.slice(0, 30)).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).not.toContain('CODE-123');
    }
  });

  it('answers 400 to an expired state', async () => {
    const state = await stateFromStart(NOW);
    expect((await relay(`/relay/callback?${new URLSearchParams({ code: 'c', state })}`, ENV, NOW + RELAY_STATE_TTL_SECONDS - 1)).status).toBe(200);
    expect((await relay(`/relay/callback?${new URLSearchParams({ code: 'c', state })}`, ENV, NOW + RELAY_STATE_TTL_SECONDS)).status).toBe(400);
  });

  it('refuses an http callback even inside a validly signed state, and an http request to the relay', async () => {
    const httpState = await mint({ v: 1, cb: 'http://ia.example.com/cb', s: 'x', e: NOW + 600 });
    const res = await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-123', state: httpState })}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();

    const good = await stateFromStart();
    const plain = await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-123', state: good })}`, ENV, NOW, 'http://connect.mock.test');
    expect(plain.status).toBe(400);
  });

  it('needs a code or an error', async () => {
    const state = await stateFromStart();
    expect((await relay(`/relay/callback?${new URLSearchParams({ state })}`)).status).toBe(400);
  });

  it('never logs the code or the state, on any path', async () => {
    const state = await stateFromStart();
    const p = await page(ENV, state, 'CODE-SECRET-777');
    await p.post();
    await p.post({ token: 'x' });
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state: state.slice(0, -3) + 'AAA' })}`);
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state })}`, ENV, NOW + 99999);
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state: await mint({ v: 1, cb: 'http://x.test/cb', s: 's', e: NOW + 600 }) })}`);
    const logged = (['warn', 'log', 'error', 'info', 'debug'] as const).flatMap(m => (console[m] as any).mock.calls);
    expect(logged).toEqual([]);
  });
});

describe('relay: registered hosts (CF_OAUTH_RELAY_ALLOWED_HOSTS)', () => {
  const env = { ...ENV, CF_OAUTH_RELAY_ALLOWED_HOSTS: ' IA.example.com , other.example.org ' };

  it('refuses any other host at start, case-insensitively accepts the listed ones', async () => {
    expect((await relay(startPath(), env)).status).toBe(302);
    expect((await relay(startPath({ cb: 'https://other.example.org/cb' }), env)).status).toBe(302);
    for (const cb of ['https://evil.example/x', 'https://ia.example.com.evil.example/x', 'https://sub.ia.example.com/x']) {
      expect((await relay(startPath({ cb }), env)).status, cb).toBe(400);
    }
  });

  it('re-checks at the callback and the confirmation: a signed state for an unlisted host never reaches the page', async () => {
    const forged = await mint({ v: 1, cb: 'https://evil.example/x', s: 's', e: NOW + 600 });
    const res = await relay(`/relay/callback?${new URLSearchParams({ code: 'c', state: forged })}`, env);
    expect(res.status).toBe(400);
    // a page issued while the host was allowed cannot be confirmed once it is not
    const state = new URL((await relay(startPath(), env)).headers.get('location')!).searchParams.get('state')!;
    const p = await page(env, state);
    expect(p.res.status).toBe(200);
    const narrowed = { ...ENV, CF_OAUTH_RELAY_ALLOWED_HOSTS: 'other.example.org' };
    const again = await relay('/relay/confirm', narrowed, NOW, RELAY, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: p.cookie },
      body: new URLSearchParams({ state: p.field('state'), code: p.field('code'), nonce: p.field('nonce'), token: p.field('token') }),
    });
    expect(again.status).toBe(400);
    expect(again.headers.get('location')).toBeNull();
  });

  it('unset means any https host (the confirmation page is then the only protection)', async () => {
    expect((await relay(startPath({ cb: 'https://anything.example/x' }))).status).toBe(302);
  });
});

describe('relay wiring', () => {
  it('the Worker serves the relay only when CF_OAUTH_RELAY_SECRET is set', async () => {
    expect(relayEnabled({})).toBe(false);
    expect(relayEnabled(ENV)).toBe(true);
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    // on: no database needed
    const on = await worker.fetch(new Request(`${RELAY}${startPath()}`), ENV as any, ctx);
    expect(on.status).toBe(302);
    expect(new URL(on.headers.get('location')!).origin).toBe('https://auth.mock.test');
    // off: the path is just another (unknown) path on the app
    const off = await worker.fetch(new Request(`${RELAY}${startPath()}`), { ...AUTH, DB: undefined, ASSETS: { fetch: async () => new Response('app', { status: 200 }) } } as any, ctx);
    expect(off.headers.get('location')).toBeNull();
  });
});

describe('self-host OAuth through the relay, end to end', () => {
  it('instance → relay → Cloudflare → relay → instance, then the instance redeems the code itself', async () => {
    const db = createMigratedD1();
    const instance = { ...AUTH, TOKEN_ENCRYPTION_KEY: `k1:${KEY}`, CF_OAUTH_RELAY_URL: RELAY, CLOUDFLARE_API_TOKEN: '' };
    const env = makeEnv(db, instance) as any;
    const owner = await setupOwner(env);
    const cf = new FakeCloudflare({});
    cf.accounts = [{ id: 'cf-1', name: 'Self Hosted' }];
    cf.validTokens = new Set();
    const auth = new MockAuthServer();
    auth.onIssue = a => cf.validTokens!.add(a);
    vi.stubGlobal('fetch', async (i: any, init: any) => (await auth.handle(i, init)) ?? cf.fetch(i, init));

    // 1. the instance hands out a relay URL, not Cloudflare's
    const start = await call(env, 'POST', '/api/cloudflare/oauth/start', { key: owner, body: { label: 'Mine', return_to: '/settings' } });
    const { authorize_url } = await start.json() as any;
    expect(authorize_url.startsWith(`${RELAY}/relay/start?`)).toBe(true);
    expect(new URL(authorize_url).searchParams.get('cb')).toBe(CB);
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    expect((await (await call(env, 'GET', '/api/cloudflare/connections', { key: owner })).json() as any).oauth.via_relay).toBe(true);

    // 2. relay → Cloudflare (mock), consent, back to the relay
    const toCf = await handleRelay(new Request(authorize_url), { ...AUTH, CF_OAUTH_RELAY_SECRET: SECRET }, Math.floor(Date.now() / 1000));
    expect(toCf.status).toBe(302);
    const backToRelay = auth.authorize(toCf.headers.get('location')!);
    expect(backToRelay.startsWith(`${RELAY}/relay/callback?`)).toBe(true);

    // 3. relay → (user confirms) → instance: only code + the instance's state
    // the relay asks the user to confirm where the code is going; the user clicks Continue
    const nowS = Math.floor(Date.now() / 1000);
    const confirmPageRes = await handleRelay(new Request(backToRelay), { ...AUTH, CF_OAUTH_RELAY_SECRET: SECRET }, nowS);
    expect(confirmPageRes.status).toBe(200);
    const html = await confirmPageRes.text();
    expect(html).toContain('Continue to ia.example.com');
    const field = (n: string) => html.match(new RegExp(`name="${n}" value="([^"]*)"`))![1];
    const toInstance = await handleRelay(new Request(`${RELAY}/relay/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: confirmPageRes.headers.get('set-cookie')!.split(';')[0] },
      body: new URLSearchParams({ state: field('state'), code: field('code'), nonce: field('nonce'), token: field('token') }),
    }), { ...AUTH, CF_OAUTH_RELAY_SECRET: SECRET }, nowS);
    const cb = new URL(toInstance.headers.get('location')!);
    expect([...cb.searchParams.keys()].sort()).toEqual(['code', 'state']);

    // 4. the instance verifies its own state and redeems the code, with the relay's redirect URI
    const done = await call(env, 'GET', cb.pathname + cb.search, { key: owner, headers: { cookie } });
    expect(done.status).toBe(302);
    expect(new URL(done.headers.get('location')!, 'https://x').pathname).toBe('/settings');
    const exchange = auth.tokenCalls.find(c => c.grant === 'authorization_code')!;
    expect(exchange.body.get('redirect_uri')).toBe(`${RELAY}/relay/callback`);
    expect(exchange.body.get('code_verifier')).toHaveLength(43);

    const list = (await (await call(env, 'GET', '/api/cloudflare/connections', { key: owner })).json() as any).connections;
    expect(list).toEqual([expect.objectContaining({ auth_type: 'oauth', label: 'Mine', cf_account_name: 'Self Hosted', status: 'active' })]);
  });
});
