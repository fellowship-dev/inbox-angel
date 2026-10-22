// The OAuth relay (connect.inboxangel.io) — code behind config, not deployed.
//
// A public OAuth client has fixed redirect URIs, but a self-hosted instance lives on any hostname. The
// relay is the one registered redirect URI. It holds no tokens and no per-instance state:
//
//   1. The instance sends the browser to  <relay>/relay/start?cb=<instance callback>&state=<instance state>&challenge=<PKCE challenge>
//      The relay wraps cb + state in its own HMAC-signed, short-lived state and redirects to Cloudflare's authorize URL
//      with redirect_uri = <relay>/relay/callback.
//   2. Cloudflare redirects the browser to  <relay>/relay/callback?code=…&state=<relay state>
//      The relay verifies its signature and expiry (tampered → 400) and requires cb to be https. It does NOT forward yet:
//      it shows a confirmation page that names the destination host. Only the user's explicit "Continue to <host>"
//      (a POST to /relay/confirm, CSRF-protected) redirects the browser to <cb>?code=…&state=<the instance's own state>
//      — nothing else is forwarded.
//
//      Why the page is mandatory: `cb` is chosen by whoever builds the /relay/start link. Without the confirmation an
//      attacker could send a victim relay/start?cb=https://evil.example/x&challenge=<attacker's PKCE challenge>, the
//      victim would consent to "Inbox Angel" at Cloudflare, and the code would land on the attacker's host, who could
//      redeem it with their own verifier. The confirmation page lets the victim see where the code is going. Do not
//      deploy the relay without it. CF_OAUTH_RELAY_ALLOWED_HOSTS (optional) additionally restricts the hosts.
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
  /** Optional: comma-separated hostnames instances may forward to. When set, any other host is refused. */
  CF_OAUTH_RELAY_ALLOWED_HOSTS?: string;
}

export const RELAY_STATE_TTL_SECONDS = 600;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const relayEnabled = (env: RelayEnv) => !!env.CF_OAUTH_RELAY_SECRET?.trim();

export const isRelayPath = (path: string) => path === '/relay/start' || path === '/relay/callback' || path === '/relay/confirm';

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
  const hosts = allowedHosts(env);
  if (hosts && !hosts.has(u.hostname.toLowerCase())) return null;
  return u;
}

/** The registered instance hosts, or null when registration is not required. */
function allowedHosts(env: RelayEnv): Set<string> | null {
  const list = (env.CF_OAUTH_RELAY_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const CONFIRM_COOKIE = 'ia_relay_confirm';

/** CSRF token for the confirmation form: binds the page to this browser (cookie nonce), this state and this code. */
const confirmData = (nonce: string, state: string, code: string) => `confirm|${nonce}|${state}|${code}`;

async function confirmToken(env: RelayEnv, nonce: string, state: string, code: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await key(env), enc.encode(confirmData(nonce, state, code)));
  return b64url(new Uint8Array(mac));
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

function confirmPage(host: string, origin: string, fields: { state: string; code: string; nonce: string; token: string }): string {
  const h = escapeHtml(host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Connect Cloudflare to ${h}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#111}
.host{font:600 1.25rem ui-monospace,monospace;background:#fff4d6;border:2px solid #d99a00;padding:.6rem .8rem;border-radius:6px;word-break:break-all}
button{font:inherit;padding:.6rem 1rem;border-radius:6px;border:0;background:#111;color:#fff;cursor:pointer}p.s{color:#555;font-size:.9rem}</style></head>
<body><h1>Send your Cloudflare authorization to this site?</h1>
<p>You just approved <strong>Inbox Angel</strong> at Cloudflare. To finish, the authorization will be handed to:</p>
<p class="host">${h}</p>
<p>Continue <strong>only if you started this from your own Inbox Angel</strong> at that address. Anyone who receives the authorization can change DNS in the Cloudflare account you approved. If you did not expect this page, close it.</p>
<form method="post" action="/relay/confirm">
<input type="hidden" name="state" value="${escapeHtml(fields.state)}"><input type="hidden" name="code" value="${escapeHtml(fields.code)}">
<input type="hidden" name="nonce" value="${escapeHtml(fields.nonce)}"><input type="hidden" name="token" value="${escapeHtml(fields.token)}">
<button type="submit">Continue to ${h}</button></form>
<p class="s">Destination: ${escapeHtml(origin)}</p></body></html>`;
}

export async function handleRelay(request: Request, env: RelayEnv, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method !== (url.pathname === '/relay/confirm' ? 'POST' : 'GET')) return bad('method not allowed', 405);
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

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (code) {
      // Do not forward yet: the user confirms the destination first.
      const state = url.searchParams.get('state')!;
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const html = confirmPage(target.hostname, target.origin, { state, code, nonce, token: await confirmToken(env, nonce, state, code) });
      return new Response(html, {
        status: 200,
        headers: headers({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          'X-Frame-Options': 'DENY',
          'Set-Cookie': `${CONFIRM_COOKIE}=${nonce}; Max-Age=${RELAY_STATE_TTL_SECONDS}; Path=/relay; HttpOnly; SameSite=Strict; Secure`,
        }),
      });
    }
    // A refusal carries no authorization: forward just the error code and the instance's state.
    if (!error) return bad('missing code');
    target.searchParams.set('error', error.replace(/[^a-z0-9_.-]/gi, '').slice(0, 60) || 'error');
    target.searchParams.set('state', st.s);
    return new Response(null, { status: 302, headers: headers({ Location: target.toString() }) });
  }

  if (url.pathname === '/relay/confirm') {
    let form: FormData;
    try { form = await request.formData(); } catch { return bad('invalid request'); }
    const field = (n: string) => (typeof form.get(n) === 'string' ? (form.get(n) as string) : '');
    const [state, code, nonce, token] = [field('state'), field('code'), field('nonce'), field('token')];
    const st = await verify(env, state, nowSeconds);
    if (!st) return bad('invalid or expired state');
    // The page must have been served to this browser, for this state and code.
    if (!code || !nonce || readCookie(request, CONFIRM_COOKIE) !== nonce) return bad('confirmation expired: start again');
    let valid = false;
    try { valid = await crypto.subtle.verify('HMAC', await key(env), unb64url(token) as BufferSource, enc.encode(confirmData(nonce, state, code))); } catch { /* malformed token */ }
    if (!valid) return bad('invalid confirmation');
    const target = acceptableCallback(env, st.cb);
    if (!target) return bad('invalid callback');
    target.searchParams.set('code', code);
    target.searchParams.set('state', st.s);
    return new Response(null, { status: 303, headers: headers({ Location: target.toString(), 'Set-Cookie': `${CONFIRM_COOKIE}=; Max-Age=0; Path=/relay; HttpOnly; SameSite=Strict; Secure` }) });
  }

  return bad('not found', 404);
}
