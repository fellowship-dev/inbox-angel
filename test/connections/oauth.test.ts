import { describe, it, expect } from 'vitest';
import { TokenCrypto } from '../../src/connections/crypto';
import {
  OAuthConfigError, OAuthStateError, STATE_TTL_SECONDS, buildAuthorizeUrl, challengeFor, newVerifier, oauthConfig, redirectUri, safeReturnTo, signState, verifyState,
} from '../../src/connections/oauth';
import { AUTH } from './mock-oauth';

const crypt = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) });
const B = { accountId: 'acct_a', userId: 'user_1', nonce: 'nonce-1' };
const NOW = 1_800_000_000;

describe('OAuth configuration', () => {
  it('is off until client id, authorize and token URLs are set; nothing is hardcoded', () => {
    expect(oauthConfig({})).toBeNull();
    expect(oauthConfig({ CF_OAUTH_CLIENT_ID: 'x', CF_OAUTH_AUTHORIZE_URL: AUTH.CF_OAUTH_AUTHORIZE_URL })).toBeNull();
    const cfg = oauthConfig(AUTH)!;
    expect(cfg).toMatchObject({ clientId: 'ia-test-client', authorizeUrl: AUTH.CF_OAUTH_AUTHORIZE_URL, tokenUrl: AUTH.CF_OAUTH_TOKEN_URL, revokeUrl: AUTH.CF_OAUTH_REVOKE_URL, scopes: ['zone:read', 'dns:edit'] });
    expect(oauthConfig({ ...AUTH, CF_OAUTH_SCOPES: 'a, b  c' })!.scopes).toEqual(['a', 'b', 'c']);
  });

  it('refuses plain-http endpoints and redirect URIs (localhost excepted)', () => {
    expect(() => oauthConfig({ ...AUTH, CF_OAUTH_TOKEN_URL: 'http://auth.mock.test/token' })).toThrow(OAuthConfigError);
    expect(oauthConfig({ ...AUTH, CF_OAUTH_TOKEN_URL: 'http://localhost:9000/token' })).not.toBeNull();
    expect(() => redirectUri({ CF_OAUTH_REDIRECT_URI: 'http://ia.example.com/cb' }, 'https://ia.example.com/x')).toThrow(OAuthConfigError);
    expect(redirectUri({}, 'https://ia.example.com/api/x')).toBe('https://ia.example.com/api/cloudflare/oauth/callback');
  });

  it('builds a PKCE S256 authorize URL from config', async () => {
    const verifier = newVerifier();
    const url = new URL(buildAuthorizeUrl(oauthConfig(AUTH)!, { redirectUri: 'https://ia.example.com/cb', state: 'S', challenge: await challengeFor(verifier) }));
    expect(url.origin + url.pathname).toBe(AUTH.CF_OAUTH_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'ia-test-client', redirect_uri: 'https://ia.example.com/cb', scope: 'zone:read dns:edit', state: 'S', code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('code_challenge')).toBe(await challengeFor(verifier));
    expect(url.toString()).not.toContain(verifier);
  });
});

describe('signed state', () => {
  it('round-trips and carries the verifier without exposing it', async () => {
    const verifier = newVerifier();
    const state = await signState(crypt, B, verifier, { label: 'Fellowship', returnTo: '/settings', connectionId: 'cfc_9' }, NOW);
    expect(state).not.toContain(verifier);
    expect(atob(state.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).not.toContain(verifier);
    expect(await verifyState(crypt, state, B, NOW + 5)).toEqual({ verifier, label: 'Fellowship', returnTo: '/settings', connectionId: 'cfc_9' });
  });

  it('rejects a tampered payload or signature', async () => {
    const state = await signState(crypt, B, newVerifier(), {}, NOW);
    const [body, sig] = state.split('.');
    const forged = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    forged.a = 'acct_b';
    const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(verifyState(crypt, `${forgedBody}.${sig}`, { ...B, accountId: 'acct_b' }, NOW)).rejects.toMatchObject({ reason: 'signature' });
    await expect(verifyState(crypt, `${body}.${sig.slice(0, -2)}AA`, B, NOW)).rejects.toMatchObject({ reason: 'signature' });
    await expect(verifyState(crypt, 'garbage', B, NOW)).rejects.toMatchObject({ reason: 'malformed' });
    await expect(verifyState(crypt, `${body}.`, B, NOW)).rejects.toBeInstanceOf(OAuthStateError);
  });

  it('expires after the TTL', async () => {
    const state = await signState(crypt, B, newVerifier(), {}, NOW);
    await expect(verifyState(crypt, state, B, NOW + STATE_TTL_SECONDS - 1)).resolves.toBeDefined();
    await expect(verifyState(crypt, state, B, NOW + STATE_TTL_SECONDS)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('is bound to the account, the user and the browser nonce', async () => {
    const state = await signState(crypt, B, newVerifier(), {}, NOW);
    for (const other of [{ ...B, accountId: 'acct_b' }, { ...B, userId: 'user_2' }, { ...B, nonce: 'nonce-2' }]) {
      await expect(verifyState(crypt, state, other, NOW)).rejects.toMatchObject({ reason: 'mismatch' });
    }
  });

  it('is not valid under another key', async () => {
    const state = await signState(crypt, B, newVerifier(), {}, NOW);
    const other = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(8))) });
    await expect(verifyState(other, state, B, NOW)).rejects.toMatchObject({ reason: 'signature' });
  });

  it('only returns to paths on this origin', () => {
    expect(safeReturnTo('/settings/cloudflare')).toBe('/settings/cloudflare');
    expect(safeReturnTo('/#/settings')).toBe('/#/settings');
    for (const bad of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '/a\r\nSet-Cookie: x', 42, undefined]) {
      expect(safeReturnTo(bad)).toBeUndefined();
    }
  });
});
