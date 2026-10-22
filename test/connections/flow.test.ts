import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenCrypto } from '../../src/connections/crypto';
import { newVerifier, signState } from '../../src/connections/oauth';
import { KEY, Z, world, type World } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => {
  for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const loc = (r: Response) => new URL(r.headers.get('location')!, 'https://x');
const envelopeOf = (w: World, id: string) => w.rows('SELECT token_envelope FROM cloudflare_connections WHERE id = ?', id)[0].token_envelope as string;

/** Connect via OAuth as A, allow `zones`, link `domains`. */
async function oauthFor(w: World, zones: string[], domains: number[] = []) {
  const { res } = await w.connectOAuth(w.A.token);
  const id = w.connectionId(res);
  if (zones.length) expect((await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: zones })).status).toBe(200);
  for (const d of domains) expect((await w.api(w.A.token, 'PUT', `/api/domains/${d}/connection`, { connection_id: id })).status).toBe(200);
  return id;
}

describe('OAuth flow (against a mock authorization server)', () => {
  it('start → consent → callback stores an encrypted connection and sends the browser back', async () => {
    const w = await world();
    const start = await w.api(w.A.token, 'POST', '/api/cloudflare/oauth/start', { label: 'Fellowship CF', return_to: '/settings/cloudflare' });
    expect(start.status).toBe(200);
    const { authorize_url } = await json(start);
    const url = new URL(authorize_url);
    expect(url.origin + url.pathname).toBe('https://auth.mock.test/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('zone:read dns:edit');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ia.example.com/api/cloudflare/oauth/callback');
    const setCookie = start.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^ia_cf_oauth=.+; Max-Age=600; Path=\/api\/cloudflare\/oauth; HttpOnly; SameSite=Lax; Secure/);

    const { res } = await w.connectOAuth(w.A.token, { label: 'Fellowship CF' });
    expect(res.status).toBe(302);
    expect(loc(res).pathname).toBe('/settings/cloudflare');
    const id = w.connectionId(res);
    expect(id).toMatch(/^cfc_/);
    expect(res.headers.get('set-cookie')).toMatch(/ia_cf_oauth=; Max-Age=0/);

    // the token endpoint saw the PKCE verifier; the authorize URL never carried it
    const exchange = w.auth.tokenCalls.find(c => c.grant === 'authorization_code')!;
    expect(exchange.body.get('code_verifier')).toHaveLength(43);
    expect(authorize_url).not.toContain(exchange.body.get('code_verifier')!);

    const list = await json(await w.api(w.A.token, 'GET', '/api/cloudflare/connections'));
    expect(list.oauth).toEqual({ available: true, scopes: ['zone:read', 'dns:edit'], via_relay: false });
    expect(list.connections).toEqual([expect.objectContaining({
      id, label: 'Fellowship CF', auth_type: 'oauth', status: 'active', cf_account_id: 'cf-1', cf_account_name: 'Fellowship',
      scopes: ['zone:read', 'dns:edit'], zones: [], created_by: expect.any(String),
    })]);

    // stored encrypted, never in the clear, and never in what the API returns
    const envelope = envelopeOf(w, id);
    expect(envelope).toMatch(/^ia1\.k1\./);
    expect(envelope).not.toContain('access-');
    expect(JSON.stringify(list)).not.toMatch(/access-|refresh-|ia1\./);
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'cf_connection.create'")).toHaveLength(1);
  });

  it('a declined consent returns to the app with the error and stores nothing', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token, { approve: false });
    expect(res.status).toBe(302);
    expect(loc(res).searchParams.get('cf_error')).toBe('access_denied');
    expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
  });

  it('is unavailable until the OAuth client is configured', async () => {
    const w = await world({ CF_OAUTH_CLIENT_ID: undefined });
    const r = await w.api(w.A.token, 'POST', '/api/cloudflare/oauth/start', {});
    expect(r.status).toBe(404);
    expect((await json(r)).code).toBe('oauth_not_configured');
    expect((await json(await w.api(w.A.token, 'GET', '/api/cloudflare/connections'))).oauth.available).toBe(false);
  });

  it('needs TOKEN_ENCRYPTION_KEY: nothing is stored without it', async () => {
    const w = await world({ TOKEN_ENCRYPTION_KEY: undefined });
    const r = await w.api(w.A.token, 'POST', '/api/cloudflare/oauth/start', {});
    expect(r.status).toBe(503);
    expect((await json(r)).code).toBe('encryption_not_configured');
    const list = await json(await w.api(w.A.token, 'GET', '/api/cloudflare/connections'));
    expect(list.oauth.available).toBe(false);
    expect(list.encryption_configured).toBe(false);
  });

  describe('state', () => {
    it('a tampered state is refused (400) and no code is redeemed', async () => {
      const w = await world();
      const f = await w.connectOAuth(w.A.token, { defer: true });
      const state = f.back.searchParams.get('state')!;
      const [body, sig] = state.split('.');
      const tamperedBody = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21);
      for (const bad of [`${tamperedBody}.${sig}`, `${body}.${sig.slice(0, -3)}AAA`, 'x.y', '']) {
        const calls = w.auth.tokenCalls.length;
        const r = await f.callback(bad);
        expect(r.status).toBe(400);
        expect(w.auth.tokenCalls.length).toBe(calls);
      }
      expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
      expect((await f.callback()).status).toBe(302); // the untouched state still works
      expect(w.rows('SELECT id FROM cloudflare_connections')).toHaveLength(1);
    });

    it('an expired state is refused', async () => {
      const w = await world();
      const f = await w.connectOAuth(w.A.token, { defer: true });
      // a state minted 20 minutes ago, with the matching cookie
      const crypt = TokenCrypto.fromEnv(w.env);
      const user = w.rows('SELECT m.user_id FROM memberships m WHERE m.account_id = ? AND m.role = ?', w.A.acct, 'owner')[0].user_id;
      const old = await signState(crypt, { accountId: w.A.acct, userId: user, nonce: 'n-old' }, newVerifier(), {}, Math.floor(Date.now() / 1000) - 1200);
      const r = await f.callback(old, 'ia_cf_oauth=n-old');
      expect(r.status).toBe(400);
      expect((await json(r)).code).toBe('oauth_state_expired');
    });

    it('is bound to the browser: another browser (no cookie, or another one) cannot finish the flow', async () => {
      const w = await world();
      const f = await w.connectOAuth(w.A.token, { defer: true });
      const state = f.back.searchParams.get('state')!;
      expect((await f.callback(state, '')).status).toBe(400);
      expect((await f.callback(state, 'ia_cf_oauth=somebody-else')).status).toBe(400);
      expect(w.auth.tokenCalls.filter(c => c.grant === 'authorization_code')).toHaveLength(0);
    });

    it('is bound to the account and user: B cannot complete A\'s flow, even with A\'s cookie', async () => {
      const w = await world();
      const f = await w.connectOAuth(w.A.token, { defer: true });
      const state = f.back.searchParams.get('state')!;
      const u = new URL(f.back);
      u.searchParams.set('state', state);
      const r = await w.api(w.B.token, 'GET', u.pathname + u.search, undefined, { cookie: f.cookie });
      expect(r.status).toBe(400);
      expect((await json(r)).code).toBe('oauth_state_mismatch');
      expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
    });

    it('a code cannot be replayed: the second callback stores nothing', async () => {
      const w = await world();
      const f = await w.connectOAuth(w.A.token);
      expect(f.res.status).toBe(302);
      const again = await f.callback();
      expect(again.status).toBe(400);
      expect((await json(again)).code).toBe('oauth_state_used');
      expect(w.auth.tokenCalls.filter(c => c.grant === 'authorization_code')).toHaveLength(1); // the replay never reached the token endpoint
      expect(w.rows('SELECT id FROM cloudflare_connections')).toHaveLength(1);
    });
  });
});

describe('tokens: refresh, retry, broken, revoke', () => {
  it('refreshes an expired access token once, then uses the new one', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    const before = envelopeOf(w, id);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const res = await w.dmarc(w.A.token, 1);
    expect(res.status).toBe(200);

    const refreshes = w.auth.tokenCalls.filter(c => c.grant === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body.get('client_id')).toBe('ia-test-client');
    const writes = w.cf.calls.filter(c => c.zoneId === Z.a1);
    expect(writes.length).toBeGreaterThan(1); // several Cloudflare calls, one refresh
    expect(new Set(writes.map(c => c.auth))).toEqual(new Set([`Bearer access-${refreshTokenNumber(w)}-secret`]));
    const after = envelopeOf(w, id);
    expect(after).not.toBe(before);
    expect(after).not.toContain('access-');
  });

  it('shares one in-flight refresh between concurrent calls in a request', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const { loadTenant } = await import('../../src/tenancy/load');
    const tenant = await loadTenant(w.env, { accountId: w.A.acct });
    const cf = await tenant.connections.clientFor(id);
    await Promise.all([cf.listDnsRecords(Z.a1, {}), cf.listDnsRecords(Z.a1, {}), cf.listDnsRecords(Z.a1, {})]);
    expect(w.auth.tokenCalls.filter(c => c.grant === 'refresh_token')).toHaveLength(1);
  });

  it('two requests racing to refresh the same single-use token both succeed; the connection stays active', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const [r1, r2] = await Promise.all([w.dmarc(w.A.token, 1, 'v=DMARC1; p=none'), w.dmarc(w.A.token, 1, 'v=DMARC1; p=quarantine')]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const list = await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`));
    expect(list.connection.status).toBe('active');
  });

  it('a 401 from Cloudflare triggers one refresh and one retry', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    w.cf.validTokens!.clear(); // Cloudflare no longer accepts the access token we hold (expired early / rotated)
    const res = await w.dmarc(w.A.token, 1);
    expect(res.status).toBe(200);
    expect(w.auth.tokenCalls.filter(c => c.grant === 'refresh_token')).toHaveLength(1);
    const first = w.cf.calls.find(c => c.zoneId === undefined || c.zoneId === Z.a1)!;
    expect(w.cf.calls.filter(c => c.auth !== first.auth).length).toBeGreaterThan(0); // the retry used the new token
    expect((await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`))).connection.status).toBe('active');
  });

  it('a refresh Cloudflare refuses marks the connection broken, alerts once, and answers with a typed error', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    w.auth.refreshRejected = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);

    const res = await w.dmarc(w.A.token, 1);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'cf_connection_broken', connection_id: id });
    const conn = (await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`))).connection;
    expect(conn.status).toBe('broken');
    expect(conn.status_detail).toMatch(/reconnect/);

    // the alert path: an audit entry and an email to the owner/admins
    await vi.waitFor(() => expect(w.rows("SELECT action FROM audit_log WHERE action = 'cf_connection.broken'")).toHaveLength(1));
    expect(w.send).toHaveBeenCalledTimes(2); // the owner and the admin
    const mails = w.send.mock.calls.map((c: any) => c[0]);
    expect(mails.flatMap((m: any) => m.to).sort()).toEqual(['a@example.com', 'admin@example.com']);
    expect(mails[0].subject).toMatch(/needs attention/);

    // later calls fail fast: no more token traffic, no second alert
    const calls = w.auth.tokenCalls.length;
    const again = await w.dmarc(w.A.token, 1);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'cf_connection_broken' });
    expect(w.auth.tokenCalls.length).toBe(calls);
    expect(w.send).toHaveBeenCalledTimes(2);
  });

  it('reconnecting a broken connection through OAuth makes it active again, keeping its zones and links', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    w.auth.refreshRejected = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    expect((await w.dmarc(w.A.token, 1)).status).toBe(409);
    vi.useRealTimers();
    w.auth.refreshRejected = false;

    const { res } = await w.connectOAuth(w.A.token, { connectionId: id });
    expect(w.connectionId(res)).toBe(id);
    const conn = (await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`))).connection;
    expect(conn).toMatchObject({ status: 'active', status_detail: null, zones: [{ id: Z.a1, name: 'a-corp.com' }] });
    expect((await w.dmarc(w.A.token, 1)).status).toBe(200);
    expect(w.rows('SELECT id FROM cloudflare_connections')).toHaveLength(1);
  });

  it('disconnect revokes the grant at Cloudflare, deletes the row and unlinks the domains', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    const del = await w.api(w.A.token, 'DELETE', `/api/cloudflare/connections/${id}`);
    expect(await json(del)).toEqual({ ok: true, revoked_remote: true, unlinked_domains: 1 });
    expect(w.auth.revoked.map(r => r.hint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(w.auth.revoked.every(r => /-secret$/.test(r.token))).toBe(true);
    expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
    expect(w.rows('SELECT connection_id FROM cloudflare_connection_zones')).toEqual([]);
    expect(w.rows('SELECT cf_connection_id FROM domains WHERE id = 1')).toEqual([{ cf_connection_id: null }]);
    expect((await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`)).status).toBe(404);
  });

  it('disconnect still removes the connection when Cloudflare cannot revoke, and says so', async () => {
    const w = await world();
    const id = await oauthFor(w, []);
    w.auth.revokeFails = true;
    expect(await json(await w.api(w.A.token, 'DELETE', `/api/cloudflare/connections/${id}`))).toEqual({ ok: true, revoked_remote: false, unlinked_domains: 0 });
    expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
  });
});

/** Number n in the `access-n-secret` of the most recently issued access token. */
function refreshTokenNumber(w: World): number {
  const last = [...w.cf.validTokens!].at(-1)!;
  return Number(last.split('-')[1]);
}

describe('zone allow-list', () => {
  it('a new connection may touch no zone until the owner allows some', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    const zones = await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}/zones`));
    expect(zones.zones).toEqual(expect.arrayContaining([{ id: Z.a1, name: 'a-corp.com', allowed: false }]));
    expect(zones.zones.every((z: any) => z.allowed === false)).toBe(true);

    const link = await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: id });
    expect(link.status).toBe(400);
    expect((await json(link)).code).toBe('cf_zone_not_allowed');
    expect(w.rows('SELECT cf_connection_id FROM domains WHERE id = 1')).toEqual([{ cf_connection_id: null }]);
  });

  it('stores the allow-list with names from Cloudflare, and rejects zones the token cannot see', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    const bad = await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1, 'ffffffffffffffffffffffffffffffff'] });
    expect(bad.status).toBe(400);
    expect(w.rows('SELECT zone_id FROM cloudflare_connection_zones')).toEqual([]);
    expect((await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: Z.a1 })).status).toBe(400);

    const ok = await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1, Z.a2] });
    expect(await json(ok)).toEqual({ zones: [{ id: Z.a1, name: 'a-corp.com' }, { id: Z.a2, name: 'a-two.org' }] });
    const zones = (await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}/zones`))).zones;
    expect(zones.filter((z: any) => z.allowed).map((z: any) => z.id).sort()).toEqual([Z.a1, Z.a2]);
    // replacing shrinks it
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a2] });
    expect(w.rows('SELECT zone_id FROM cloudflare_connection_zones')).toEqual([{ zone_id: Z.a2 }]);
  });

  it('refuses a write to a zone outside the list even though the token could do it, without calling Cloudflare', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    const { loadTenant } = await import('../../src/tenancy/load');
    const tenant = await loadTenant(w.env, { accountId: w.A.acct });
    const cf = await tenant.connections.clientFor(id);
    const { CfZoneNotAllowedError } = await import('../../src/tenancy/cf-client');
    w.cf.calls.length = 0;

    await expect(cf.createDnsRecord(Z.b, { type: 'TXT', name: '_dmarc.b-corp.org', content: 'v=DMARC1; p=none' })).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.patchDnsRecord(Z.a2, 'rec', { content: 'x' })).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.deleteDnsRecord(Z.a2, 'rec')).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.request('PUT', '/zones/a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2/email/routing/enable')).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.zoneFor('a-two.org')).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.request('POST', '/accounts/cf-other/email/routing/addresses', { body: {} })).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    expect(w.cf.calls.filter(c => c.zoneId === Z.b || c.zoneId === Z.a2 || c.url.includes('cf-other'))).toEqual([]);

    // and the allowed zone works
    await expect(cf.createDnsRecord(Z.a1, { type: 'TXT', name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=none' })).resolves.toMatchObject({ name: '_dmarc.a-corp.com' });
  });

  it('shrinking the list stops writes for domains already linked: 403, nothing reaches Cloudflare', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1, Z.a2], [1, 2]);
    expect((await w.dmarc(w.A.token, 2)).status).toBe(200);
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1] });
    w.cf.calls.length = 0;
    const res = await w.dmarc(w.A.token, 2, 'v=DMARC1; p=reject');
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('cf_zone_not_allowed');
    expect(w.cf.calls.filter(c => c.method !== 'GET')).toEqual([]);
    expect(w.cf.records.get(Z.a2)).toEqual([expect.objectContaining({ content: 'v=DMARC1; p=none' })]);
  });
});

describe('several connections in one account', () => {
  it('routes each domain to the token of the connection that manages its zone', async () => {
    const w = await world();
    const pasted = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef', 'Lexgo');
    const oauthId = await oauthFor(w, [Z.a2]);
    expect((await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${pasted.id}/zones`, { zone_ids: [Z.a1] })).status).toBe(200);
    expect((await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: pasted.id })).status).toBe(200);
    expect((await w.api(w.A.token, 'PUT', '/api/domains/2/connection', { connection_id: oauthId })).status).toBe(200);

    w.cf.calls.length = 0;
    expect((await w.dmarc(w.A.token, 1)).status).toBe(200);
    expect((await w.dmarc(w.A.token, 2)).status).toBe(200);
    const authFor = (zone: string) => new Set(w.cf.forZone(zone).map(c => c.auth));
    expect(authFor(Z.a1)).toEqual(new Set(['Bearer tok-pasted-1234567890abcdef']));
    expect(authFor(Z.a2).size).toBe(1);
    expect([...authFor(Z.a2)][0]).toMatch(/^Bearer access-\d+-secret$/);
    expect(w.cf.records.get(Z.a1)).toHaveLength(1);
    expect(w.cf.records.get(Z.a2)).toHaveLength(1);

    const domains = (await json(await w.api(w.A.token, 'GET', '/api/domains'))).domains;
    expect(domains.map((d: any) => [d.domain, d.cf_connection_id])).toEqual([['a-corp.com', pasted.id], ['a-two.org', oauthId]]);
  });

  it('a domain cannot be linked to a connection whose allow-list lacks its zone', async () => {
    const w = await world();
    const a = await w.addToken(w.A.token, 'tok-one-1234567890abcdefg');
    const b = await w.addToken(w.A.token, 'tok-two-1234567890abcdefg');
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${a.id}/zones`, { zone_ids: [Z.a1] });
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${b.id}/zones`, { zone_ids: [Z.a2] });
    expect((await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: b.id })).status).toBe(400);
    expect((await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: a.id })).status).toBe(200);
    expect((await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: null })).status).toBe(200);
    expect(w.rows('SELECT cf_connection_id FROM domains WHERE id = 1')).toEqual([{ cf_connection_id: null }]);
  });

  it('a domain with no connection never falls back to a server token in saas mode', async () => {
    const w = await world({ CLOUDFLARE_API_TOKEN: 'env-token-must-not-be-used' });
    await w.addToken(w.A.token, 'tok-one-1234567890abcdefg');
    w.cf.calls.length = 0;
    const res = await w.dmarc(w.A.token, 1);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/not linked to a Cloudflare connection/);
    expect(w.cf.calls.filter(c => c.auth?.includes('env-token'))).toEqual([]);
  });
});

describe('pasted API token', () => {
  it('verifies the token with Cloudflare, then stores it encrypted', async () => {
    const w = await world();
    const secret = 'tok-pasted-SECRET-1234567890';
    const created = await w.addToken(w.A.token, secret, '  Lexgo  ');
    const list = await json(await w.api(w.A.token, 'GET', '/api/cloudflare/connections'));
    expect(list.connections[0]).toMatchObject({ id: created.id, label: 'Lexgo', auth_type: 'token', status: 'active', cf_account_id: 'cf-1', cf_account_name: 'Fellowship', zones: [] });
    expect(w.cf.calls.some(c => c.url.endsWith('/user/tokens/verify') && c.auth === `Bearer ${secret}`)).toBe(true);
    const envelope = envelopeOf(w, created.id);
    expect(envelope).not.toContain(secret);
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(w.rows('SELECT * FROM audit_log'))).not.toContain(secret);
  });

  it('refuses a token Cloudflare does not accept, and a missing one', async () => {
    const w = await world();
    const bad = await w.api(w.A.token, 'POST', '/api/cloudflare/connections', { token: 'not-a-valid-token-0123456789' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatch(/did not accept/);
    expect((await w.api(w.A.token, 'POST', '/api/cloudflare/connections', {})).status).toBe(400);
    expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
  });

  it('is refused (503) without TOKEN_ENCRYPTION_KEY, and nothing is stored', async () => {
    const w = await world({ TOKEN_ENCRYPTION_KEY: undefined });
    w.cf.validTokens!.add('tok-pasted-1234567890abcdef');
    const r = await w.api(w.A.token, 'POST', '/api/cloudflare/connections', { token: 'tok-pasted-1234567890abcdef' });
    expect(r.status).toBe(503);
    expect(w.rows('SELECT id FROM cloudflare_connections')).toEqual([]);
  });

  it('a token Cloudflare later rejects marks the connection broken; a new token fixes it', async () => {
    const w = await world();
    const c = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef');
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${c.id}/zones`, { zone_ids: [Z.a1] });
    await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: c.id });
    w.cf.validTokens!.delete('tok-pasted-1234567890abcdef');

    const res = await w.dmarc(w.A.token, 1);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('cf_connection_broken');
    expect(w.send).toHaveBeenCalledTimes(2);

    w.cf.validTokens!.add('tok-replacement-1234567890');
    const fixed = await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${c.id}/token`, { token: 'tok-replacement-1234567890' });
    expect((await json(fixed)).connection.status).toBe('active');
    expect((await w.dmarc(w.A.token, 1)).status).toBe(200);
  });

  it('deleting a pasted-token connection removes it without calling any revoke endpoint', async () => {
    const w = await world();
    const c = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef');
    expect(await json(await w.api(w.A.token, 'DELETE', `/api/cloudflare/connections/${c.id}`))).toEqual({ ok: true, revoked_remote: null, unlinked_domains: 0 });
    expect(w.auth.revoked).toEqual([]);
  });
});

describe('roles', () => {
  it('everything is for owners and admins: members get 403 on reads and writes', async () => {
    const w = await world();
    const c = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef');
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/cloudflare/connections'],
      ['POST', '/api/cloudflare/connections', { token: 'tok-x-1234567890abcdefgh' }],
      ['GET', `/api/cloudflare/connections/${c.id}`],
      ['DELETE', `/api/cloudflare/connections/${c.id}`],
      ['GET', `/api/cloudflare/connections/${c.id}/zones`],
      ['PUT', `/api/cloudflare/connections/${c.id}/zones`, { zone_ids: [] }],
      ['PUT', `/api/cloudflare/connections/${c.id}/token`, { token: 'tok-x-1234567890abcdefgh' }],
      ['POST', '/api/cloudflare/oauth/start', {}],
      ['GET', '/api/cloudflare/oauth/callback?code=x&state=y'],
      ['PUT', '/api/domains/1/connection', { connection_id: c.id }],
    ];
    for (const [m, p, b] of calls) expect((await w.api(w.member, m, p, b)).status, `${m} ${p}`).toBe(403);
    expect(w.rows('SELECT id FROM cloudflare_connections')).toHaveLength(1);
    // an admin is allowed
    expect((await w.api(w.admin, 'GET', '/api/cloudflare/connections')).status).toBe(200);
    expect((await w.api(w.admin, 'GET', `/api/cloudflare/connections/${c.id}/zones`)).status).toBe(200);
  });

  it('requires a signed-in caller', async () => {
    const w = await world();
    expect((await w.api('', 'GET', '/api/cloudflare/connections')).status).toBe(401);
  });
});

describe('cross-account isolation', () => {
  it('B can neither see nor touch A\'s connections, zones or domains', async () => {
    const w = await world();
    const c = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef');
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${c.id}/zones`, { zone_ids: [Z.a1] });
    await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: c.id });
    const snapshot = JSON.stringify([w.rows('SELECT * FROM cloudflare_connections'), w.rows('SELECT * FROM cloudflare_connection_zones'), w.rows('SELECT id, cf_connection_id FROM domains')]);

    expect((await json(await w.api(w.B.token, 'GET', '/api/cloudflare/connections'))).connections).toEqual([]);
    for (const [m, p, b] of [
      ['GET', `/api/cloudflare/connections/${c.id}`],
      ['GET', `/api/cloudflare/connections/${c.id}/zones`],
      ['PUT', `/api/cloudflare/connections/${c.id}/zones`, { zone_ids: [Z.b] }],
      ['PUT', `/api/cloudflare/connections/${c.id}/token`, { token: 'tok-evil-1234567890abcdefg' }],
      ['DELETE', `/api/cloudflare/connections/${c.id}`],
      ['PUT', '/api/domains/3/connection', { connection_id: c.id }], // B's domain, A's connection
      ['PUT', '/api/domains/1/connection', { connection_id: null }], // A's domain
      ['POST', '/api/cloudflare/oauth/start', { connection_id: c.id }],
    ] as [string, string, unknown?][]) {
      expect((await w.api(w.B.token, m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    expect(JSON.stringify([w.rows('SELECT * FROM cloudflare_connections'), w.rows('SELECT * FROM cloudflare_connection_zones'), w.rows('SELECT id, cf_connection_id FROM domains')])).toBe(snapshot);

    // A's connection still routes A's domain, and B's domain (unlinked, saas) gets no Cloudflare access
    expect((await w.dmarc(w.A.token, 1)).status).toBe(200);
    w.cf.calls.length = 0;
    expect((await w.dmarc(w.B.token, 3)).status).toBe(400);
    expect(w.cf.calls).toEqual([]);
  });

  it('the query layer is scoped too: another account\'s id finds, changes and deletes nothing', async () => {
    const w = await world();
    const c = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef');
    const { forAccount } = await import('@inbox-angel/db');
    const b = forAccount(w.env.DB, w.B.acct);
    expect(await b.connections.get(c.id)).toBeNull();
    expect(await b.connections.getSecret(c.id)).toBeNull();
    expect(await b.connections.list()).toEqual([]);
    expect(await b.connections.setZones(c.id, [{ zone_id: Z.b, zone_name: 'b-corp.org' }])).toBe(false);
    expect(await b.connections.delete(c.id)).toBe(false);
    expect(await b.domains.setConnection(3, c.id)).toBe(false);
    expect(await b.connections.markBroken(c.id, 'x')).toBe(false);
    expect(await b.connections.swapEnvelope(c.id, envelopeOf(w, c.id), 'x')).toBe(false);
    expect(w.rows('SELECT status FROM cloudflare_connections')).toEqual([{ status: 'active' }]);
  });
});

describe('no plaintext anywhere', () => {
  it('tokens appear in no log line, response, audit entry or table column; only the ciphertext column holds them, encrypted', async () => {
    const w = await world();
    const bodies: string[] = [];
    const seen = async (r: Response) => { bodies.push(await r.clone().text()); return r; };
    const pasted = 'tok-pasted-SECRET-abcdefghijkl';
    w.cf.validTokens!.add(pasted);

    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    await seen(await w.api(w.A.token, 'POST', '/api/cloudflare/connections', { token: pasted }));
    await seen(await w.api(w.A.token, 'GET', '/api/cloudflare/connections'));
    await seen(await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1] }));
    await seen(await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: id }));
    await seen(await w.dmarc(w.A.token, 1));
    w.cf.validTokens!.clear();
    await seen(await w.dmarc(w.A.token, 1)); // forces a refresh + retry
    w.auth.refreshRejected = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    await seen(await w.dmarc(w.A.token, 1)); // breaks it
    vi.useRealTimers();
    await seen(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`));
    await seen(await w.api(w.A.token, 'DELETE', `/api/cloudflare/connections/${id}`));
    await vi.waitFor(() => expect(w.rows("SELECT action FROM audit_log WHERE action LIKE 'cf_connection.%'").length).toBeGreaterThan(2));

    const logs = (['warn', 'log', 'error', 'info'] as const).flatMap(m => (console[m] as any).mock.calls as unknown[][]);
    const mail = JSON.stringify(w.send.mock.calls);
    const haystack = everythingExceptCiphertext(w, logs, bodies) + mail;
    for (const secret of [pasted, 'access-1-secret', 'refresh-1-secret', 'access-2-secret', 'refresh-2-secret', 'access-3-secret', 'refresh-3-secret', KEY]) {
      expect(haystack, secret).not.toContain(secret);
    }
    expect(haystack).not.toMatch(/(access|refresh)-\d+-secret/);
    expect(haystack).not.toContain('ia1.k1.');
  });
});

function everythingExceptCiphertext(w: World, logs: unknown[][], bodies: string[]): string {
  return JSON.stringify([
    logs.map(l => l.map(x => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : x))),
    bodies,
    w.rows('SELECT * FROM audit_log'),
    w.rows('SELECT id, account_id, label, cf_account_id, cf_account_name, auth_type, scopes, status, status_detail, created_by FROM cloudflare_connections'),
    w.rows('SELECT * FROM cloudflare_connection_zones'),
  ]);
}

describe('key problems are the operator\'s, not the customer\'s', () => {
  it('a changed or dropped key answers 503 and logs, without breaking the connection or alerting anyone', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    const originalKey = w.env.TOKEN_ENCRYPTION_KEY;
    w.env.TOKEN_ENCRYPTION_KEY = `k9:${btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))}`; // k1 is gone
    (console.error as any).mockClear();

    const res = await w.dmarc(w.A.token, 1);
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toMatch(/operator/);
    expect(w.rows('SELECT status FROM cloudflare_connections')).toEqual([{ status: 'active' }]);
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'cf_connection.broken'")).toEqual([]);
    expect(w.send).not.toHaveBeenCalled();
    const logged = (console.error as any).mock.calls.map((c: unknown[]) => c.join(' ')).filter((l: string) => l.includes('[connections]'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(id);
    expect(logged[0]).not.toMatch(/access-|refresh-|ia1\./);
    const list = await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}`);
    expect(list.status).toBe(200); // reading metadata needs no key
    expect((await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}/zones`)).status).toBe(503);

    // restoring the key restores service: nothing was lost
    w.env.TOKEN_ENCRYPTION_KEY = originalKey;
    expect((await w.dmarc(w.A.token, 1)).status).toBe(200);
  });

  it('rotating by prepending a new key keeps working, and the next use re-seals under the new key', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    expect(envelopeOf(w, id)).toMatch(/^ia1\.k1\./);
    w.env.TOKEN_ENCRYPTION_KEY = `k2:${btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))},k1:${KEY}`;
    expect((await w.dmarc(w.A.token, 1)).status).toBe(200);
    expect(envelopeOf(w, id)).toMatch(/^ia1\.k2\./);
    expect((await w.dmarc(w.A.token, 1, 'v=DMARC1; p=reject')).status).toBe(200);
    expect(w.rows('SELECT status FROM cloudflare_connections')).toEqual([{ status: 'active' }]);
  });
});

describe('/accounts/* calls are limited to the connection\'s Cloudflare account', () => {
  async function restricted(w: World) {
    const id = await oauthFor(w, [Z.a1]);
    const { loadTenant } = await import('../../src/tenancy/load');
    const tenant = await loadTenant(w.env, { accountId: w.A.acct });
    return { id, cf: await tenant.connections.clientFor(id) };
  }

  it('with no recorded account (several visible), the account of the allowed zones is used', async () => {
    const w = await world();
    w.cf.accounts = [{ id: 'cf-1', name: 'One' }, { id: 'cf-2', name: 'Two' }];
    const { id, cf } = await restricted(w);
    expect(w.rows('SELECT cf_account_id FROM cloudflare_connections')).toEqual([{ cf_account_id: null }]);
    expect(w.rows('SELECT cf_account_id FROM cloudflare_connection_zones WHERE connection_id = ?', id)).toEqual([{ cf_account_id: 'cf-1' }]);
    const { CfZoneNotAllowedError, CfNotFoundError } = await import('../../src/tenancy/cf-client');
    w.cf.calls.length = 0;
    await expect(cf.request('POST', '/accounts/cf-2/email/routing/addresses', { body: {} })).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.request('GET', '/accounts/cf-other/workers/subdomain')).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.request('GET', '/accounts')).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    expect(w.cf.calls).toEqual([]);
    await expect(cf.request('GET', '/accounts/cf-1/workers/subdomain')).rejects.toBeInstanceOf(CfNotFoundError); // reached Cloudflare (the fake has no such route)
  });

  it('when no account can be determined, every /accounts call is refused', async () => {
    const w = await world();
    w.cf.accounts = [];
    for (const z of Object.values(w.cf.zones)) z.accountId = undefined;
    const { cf } = await restricted(w);
    expect(w.rows('SELECT cf_account_id FROM cloudflare_connections')).toEqual([{ cf_account_id: null }]);
    const { CfZoneNotAllowedError } = await import('../../src/tenancy/cf-client');
    w.cf.calls.length = 0;
    for (const p of ['/accounts/cf-1/workers/subdomain', '/accounts/cf-1/email/routing/addresses', '/accounts']) {
      await expect(cf.request('GET', p), p).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    }
    expect(w.cf.calls).toEqual([]);
  });
});

describe('reconnecting must reach the same Cloudflare account', () => {
  it('OAuth: a grant for another account is refused, revoked, and the connection is left as it was', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1], [1]);
    const before = envelopeOf(w, id);
    w.auth.revoked.length = 0;
    w.cf.accounts = [{ id: 'cf-9', name: 'Someone else' }];

    const { res } = await w.connectOAuth(w.A.token, { connectionId: id });
    expect(res.status).toBe(302);
    expect(loc(res).searchParams.get('cf_error')).toBe('cf_account_mismatch');
    expect(loc(res).searchParams.get('cf_connection')).toBeNull();
    expect(envelopeOf(w, id)).toBe(before);
    expect(w.auth.revoked.map(r => r.hint).sort()).toEqual(['access_token', 'refresh_token']); // the new grant was handed back
    expect(w.rows('SELECT status, cf_account_id FROM cloudflare_connections')).toEqual([{ status: 'active', cf_account_id: 'cf-1' }]);
    expect(w.rows('SELECT zone_id FROM cloudflare_connection_zones')).toEqual([{ zone_id: Z.a1 }]);
  });

  it('OAuth: the same account reconnects (also when only the zones identify it)', async () => {
    const w = await world();
    w.cf.accounts = [{ id: 'cf-1', name: 'One' }, { id: 'cf-2', name: 'Two' }]; // no single account recorded
    const id = await oauthFor(w, [Z.a1]);
    const { res } = await w.connectOAuth(w.A.token, { connectionId: id });
    expect(loc(res).searchParams.get('cf_connection')).toBe(id);
    w.cf.accounts = [{ id: 'cf-2', name: 'Two' }]; // the zone's account is not visible any more
    const { res: wrong } = await w.connectOAuth(w.A.token, { connectionId: id });
    expect(loc(wrong).searchParams.get('cf_error')).toBe('cf_account_mismatch');
  });

  it('pasted token: a token for another account is refused (409) and the stored one is untouched', async () => {
    const w = await world();
    const c = await w.addToken(w.A.token, 'tok-pasted-1234567890abcdef');
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${c.id}/zones`, { zone_ids: [Z.a1] });
    const before = envelopeOf(w, c.id);
    w.cf.accounts = [{ id: 'cf-9', name: 'Someone else' }];
    w.cf.validTokens!.add('tok-other-account-1234567890');
    const res = await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${c.id}/token`, { token: 'tok-other-account-1234567890' });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('cf_account_mismatch');
    expect(envelopeOf(w, c.id)).toBe(before);

    w.cf.accounts = [{ id: 'cf-1', name: 'One' }];
    w.cf.validTokens!.add('tok-same-account-1234567890');
    expect((await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${c.id}/token`, { token: 'tok-same-account-1234567890' })).status).toBe(200);
  });
});

describe('zone id and path hardening', () => {
  async function client(w: World, zones = [Z.a1]) {
    const id = await oauthFor(w, zones);
    const { loadTenant } = await import('../../src/tenancy/load');
    const tenant = await loadTenant(w.env, { accountId: w.A.acct });
    return tenant.connections.clientFor(id);
  }

  it('only well-formed zone ids can be allow-listed', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    for (const bad of ['zone-a1', '../x', Z.a1.toUpperCase(), Z.a1 + '0', '%2e%2e']) {
      const r = await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [bad] });
      expect(r.status, bad).toBe(400);
    }
    expect(w.rows('SELECT zone_id FROM cloudflare_connection_zones')).toEqual([]);
  });

  it('dot segments, encoded separators and look-alike ids never reach Cloudflare', async () => {
    const w = await world();
    const cf = await client(w);
    w.cf.calls.length = 0;
    for (const path of [
      `/zones/${Z.a1}/../${Z.a2}/dns_records`,
      `/zones/${Z.a1}/%2e%2e/${Z.a2}/dns_records`,
      `/zones/${Z.a1}%2f..%2f${Z.a2}/dns_records`,
      `/zones/${Z.a1}//dns_records`,
      `/zones/${Z.a1}\\..\\x`,
      `/zones/${Z.a1.toUpperCase()}/dns_records`,
      `/zones/${Z.a1}x/dns_records`,
      `/zones/./${Z.a2}/dns_records`,
    ]) {
      await expect(cf.request('GET', path), path).rejects.toThrow();
    }
    expect(w.cf.calls).toEqual([]);
    await expect(cf.listDnsRecords(Z.a1, {})).resolves.toEqual([]);
  });
});

describe('a restricted client cannot discover zones', () => {
  it('refuses the zone list and lookups of names that were not allowed; setup-time discovery still works', async () => {
    const w = await world();
    const id = await oauthFor(w, [Z.a1]);
    const { loadTenant } = await import('../../src/tenancy/load');
    const { CfZoneNotAllowedError, CfZoneNotFoundError } = await import('../../src/tenancy/cf-client');
    const tenant = await loadTenant(w.env, { accountId: w.A.acct });
    const cf = await tenant.connections.clientFor(id);
    w.cf.calls.length = 0;

    await expect(cf.listZones()).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.request('GET', '/zones', { query: { name: 'b-corp.org' } })).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.request('GET', '/zones', { query: { per_page: 50 } })).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    await expect(cf.zoneFor('b-corp.org')).rejects.toBeInstanceOf(CfZoneNotAllowedError);
    expect(w.cf.calls).toEqual([]);

    // allowed names resolve; a sub-domain of an allowed zone resolves to the zone without asking about names that were not allowed
    await expect(cf.zoneFor('A-Corp.com')).resolves.toMatchObject({ id: Z.a1 });
    await expect(cf.zoneFor('mail.a-corp.com')).resolves.toMatchObject({ id: Z.a1 });
    expect(w.cf.calls.map(c => new URL(c.url).searchParams.get('name'))).toEqual(['a-corp.com']);
    void CfZoneNotFoundError;

    // discovery is the explicit setup path
    const zones = await json(await w.api(w.A.token, 'GET', `/api/cloudflare/connections/${id}/zones`));
    expect(zones.zones.map((z: any) => z.name).sort()).toEqual(['a-corp.com', 'a-two.org', 'b-corp.org']);
  });
});

describe('OAuth state is single use', () => {
  it('a state is spent by its first callback, even a refusal; the marker is pruned after expiry', async () => {
    const w = await world();
    const f = await w.connectOAuth(w.A.token, { approve: false });
    expect(loc(f.res).searchParams.get('cf_error')).toBe('access_denied');
    const again = await f.callback();
    expect(again.status).toBe(400);
    expect((await json(again)).code).toBe('oauth_state_used');
    expect(w.rows("SELECT key FROM settings WHERE key LIKE 'cf_oauth_used:%'")).toHaveLength(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3600 * 1000);
    const next = await w.connectOAuth(w.A.token);
    expect(next.res.status).toBe(302);
    expect(w.rows("SELECT key FROM settings WHERE key LIKE 'cf_oauth_used:%'")).toHaveLength(1); // the old marker was pruned
  });

  it('concurrent callbacks with the same state: exactly one gets through', async () => {
    const w = await world();
    const f = await w.connectOAuth(w.A.token, { defer: true });
    const results = await Promise.all([f.callback(), f.callback(), f.callback()]);
    expect(results.map(r => r.status).sort()).toEqual([302, 400, 400]);
    expect(w.rows('SELECT id FROM cloudflare_connections')).toHaveLength(1);
  });
});
