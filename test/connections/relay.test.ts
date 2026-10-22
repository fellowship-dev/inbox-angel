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

describe('relay: /relay/callback', () => {
  async function stateFromStart(now = NOW) {
    const to = new URL((await relay(startPath(), ENV, now)).headers.get('location')!);
    return to.searchParams.get('state')!;
  }

  it('forwards only the code and the instance\'s own state', async () => {
    const state = await stateFromStart();
    const res = await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-123', state, extra: 'x', access_token: 'leak', iss: 'cf' })}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(CB);
    expect(Object.fromEntries(to.searchParams)).toEqual({ code: 'CODE-123', state: 'INSTANCE.STATE' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('forwards a refusal (error code only)', async () => {
    const state = await stateFromStart();
    const res = await relay(`/relay/callback?${new URLSearchParams({ error: 'access_denied', error_description: '<script>', state })}`);
    expect(Object.fromEntries(new URL(res.headers.get('location')!).searchParams)).toEqual({ error: 'access_denied', state: 'INSTANCE.STATE' });
  });

  it('answers 400 to a tampered, forged, truncated or foreign-signed state, and never redirects', async () => {
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
    expect((await relay(`/relay/callback?${new URLSearchParams({ code: 'c', state })}`, ENV, NOW + RELAY_STATE_TTL_SECONDS - 1)).status).toBe(302);
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
    expect(plain.headers.get('location')).toBeNull();
  });

  it('needs a code or an error', async () => {
    const state = await stateFromStart();
    expect((await relay(`/relay/callback?${new URLSearchParams({ state })}`)).status).toBe(400);
  });

  it('never logs the code or the state, on any path', async () => {
    const state = await stateFromStart();
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state })}`);
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state: state.slice(0, -3) + 'AAA' })}`);
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state })}`, ENV, NOW + 99999);
    await relay(`/relay/callback?${new URLSearchParams({ code: 'CODE-SECRET-777', state: await mint({ v: 1, cb: 'http://x.test/cb', s: 's', e: NOW + 600 }) })}`);
    const logged = (['warn', 'log', 'error', 'info', 'debug'] as const).flatMap(m => (console[m] as any).mock.calls);
    expect(logged).toEqual([]);
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

    // 3. relay → instance: only code + the instance's state
    const toInstance = await handleRelay(new Request(backToRelay), { ...AUTH, CF_OAUTH_RELAY_SECRET: SECRET }, Math.floor(Date.now() / 1000));
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
