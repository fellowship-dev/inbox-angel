// The OAuth relay (connect.inboxangel.io) — code behind config, not deployed.
//
// A public OAuth client has fixed redirect URIs, but a self-hosted instance lives on any hostname. The
// relay is the one registered redirect URI. It holds no tokens and no per-instance state:
//
//   1. The instance sends the browser to  <relay>/relay/start?cb=<instance callback>&state=<instance state>&challenge=<PKCE challenge>
//      The relay wraps cb + state in its own HMAC-signed, short-lived state and redirects to Cloudflare's authorize URL
//      with redirect_uri = <relay>/relay/callback.
//   2. Cloudflare redirects the browser to  <relay>/relay/callback?code=…&state=<relay state>
//      The relay verifies its signature and expiry (tampered → 400), requires cb to be https, and redirects the browser to
//      <cb>?code=…&state=<the instance's own state>  — nothing else is forwarded.
//   3. The instance verifies its own state and redeems the code at Cloudflare's token endpoint with the PKCE verifier
//      that never left the instance. The relay can neither redeem the code nor see a token.
//
// The relay never logs a request URL, a code or a state. Responses carry no-store and no-referrer.
// Enabled only when CF_OAUTH_RELAY_SECRET is set (the relay deployment); the same code is inert everywhere else.

import { b64url, unb64url } from './crypto';
import { isSecureUrl, oauthConfig, redirectUri as configuredRedirect, type OAuthEnv } from './oauth';

export interface RelayEnv extends OAuthEnv {
  CF_OAUTH_RELAY_SECRET?: string;
  /** Optional: the only callback path instances may forward to (default: any path on an https host). */
  CF_OAUTH_RELAY_CALLBACK_PATH?: string;
}

export const RELAY_STATE_TTL_SECONDS = 600;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const relayEnabled = (env: RelayEnv) => !!env.CF_OAUTH_RELAY_SECRET?.trim();

export const isRelayPath = (path: string) => path === '/relay/start' || path === '/relay/callback';

interface RelayState { v: 1; cb: string; s: string; e: number }

const headers = (extra: Record<string, string> = {}) => ({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  ...extra,
});

const bad = (message: string, status = 400) => new Response(message, { status, headers: headers({ 'Content-Type': 'text/plain' }) });

async function key(env: RelayEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(env.CF_OAUTH_RELAY_SECRET!.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env: RelayEnv, st: RelayState): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(st)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verify(env: RelayEnv, state: string, nowSeconds: number): Promise<RelayState | null> {
  const [body, sig, extra] = state.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await key(env), unb64url(sig) as BufferSource, enc.encode(body)))) return null;
    const st = JSON.parse(dec.decode(unb64url(body))) as RelayState;
    if (st.v !== 1 || typeof st.cb !== 'string' || typeof st.s !== 'string' || typeof st.e !== 'number' || st.e <= nowSeconds) return null;
    return st;
  } catch {
    return null;
  }
}

/** The callback the instance wants the browser back on: https (localhost excepted), no credentials, no fragment. */
function acceptableCallback(env: RelayEnv, cb: string): URL | null {
  if (!isSecureUrl(cb)) return null;
  const u = new URL(cb);
  if (u.username || u.password || u.hash) return null;
  const only = env.CF_OAUTH_RELAY_CALLBACK_PATH?.trim();
  if (only && u.pathname !== only) return null;
  return u;
}

export async function handleRelay(request: Request, env: RelayEnv, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Response> {
  const url = new URL(request.url);
  if (request.method.toUpperCase() !== 'GET') return bad('method not allowed', 405);
  // Never over plain http: the code would cross the network in the clear.
  if (url.protocol !== 'https:' && !isSecureUrl(url.toString())) return bad('https required');

  if (url.pathname === '/relay/start') {
    const cfg = oauthConfig(env);
    if (!cfg) return bad('relay is not configured', 503);
    const cb = url.searchParams.get('cb') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('challenge') ?? '';
    if (!acceptableCallback(env, cb)) return bad('invalid callback');
    if (!state || state.length > 2000 || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return bad('invalid request');

    const relayState = await sign(env, { v: 1, cb, s: state, e: nowSeconds + RELAY_STATE_TTL_SECONDS });
    const authorize = new URL(cfg.authorizeUrl);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', cfg.clientId);
    authorize.searchParams.set('redirect_uri', configuredRedirect({ ...env, CF_OAUTH_REDIRECT_URI: env.CF_OAUTH_REDIRECT_URI || `${url.origin}/relay/callback` }, request.url));
    if (cfg.scopes.length) authorize.searchParams.set('scope', cfg.scopes.join(' '));
    authorize.searchParams.set('state', relayState);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    return new Response(null, { status: 302, headers: headers({ Location: authorize.toString() }) });
  }

  if (url.pathname === '/relay/callback') {
    const st = await verify(env, url.searchParams.get('state') ?? '', nowSeconds);
    if (!st) return bad('invalid or expired state');
    const target = acceptableCallback(env, st.cb);
    if (!target) return bad('invalid callback');

    // Forward the code (or the error) and the instance's own state: nothing else.
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (code) target.searchParams.set('code', code);
    else if (error) target.searchParams.set('error', error.replace(/[^a-z0-9_.-]/gi, '').slice(0, 60) || 'error');
    else return bad('missing code');
    target.searchParams.set('state', st.s);
    return new Response(null, { status: 302, headers: headers({ Location: target.toString() }) });
  }

  return bad('not found', 404);
}
