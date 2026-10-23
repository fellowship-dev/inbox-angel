// Cloudflare OAuth (authorization code + PKCE, public client): the protocol pieces, with no storage.
//
// Nothing about Cloudflare's OAuth server is hardcoded. The client id, the authorize / token / revoke
// endpoints and the scope names are Worker config (CF_OAUTH_*): register the client first, then set them.
// See docs/cloudflare-oauth.md.
//
// The PKCE verifier never travels through the browser in the clear: it is sealed into the signed `state`
// (AES-GCM under TOKEN_ENCRYPTION_KEY), so a leaked authorize URL or redirect reveals nothing that could
// redeem the code.

import { TokenCrypto, TokenMaterial, b64url, unb64url } from './crypto';

export interface OAuthEnv {
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_AUTHORIZE_URL?: string;
  CF_OAUTH_TOKEN_URL?: string;
  CF_OAUTH_REVOKE_URL?: string;
  /** Space- or comma-separated scope names. */
  CF_OAUTH_SCOPES?: string;
  /** Where Cloudflare sends the browser back. Default: `<this origin>/api/cloudflare/oauth/callback`. */
  CF_OAUTH_REDIRECT_URI?: string;
}

export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
}

/** A redirect URI or endpoint that is not https (localhost excepted, for development). */
export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

/** The authorization server refused, or answered nonsense. Never carries a token or a code. */
export class OAuthError extends Error {
  constructor(
    message: string,
    /** The OAuth `error` code ("invalid_grant", …) when the server sent one. */
    readonly code: string | undefined,
    /** True when retrying with the same credentials cannot succeed (the grant is gone). */
    readonly permanent: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export type OAuthStateFailure = 'malformed' | 'signature' | 'expired' | 'mismatch';

/** The `state` is not one we issued for this user, workspace and browser (or it is stale). */
export class OAuthStateError extends Error {
  constructor(readonly reason: OAuthStateFailure) {
    super(`invalid OAuth state (${reason})`);
    this.name = 'OAuthStateError';
  }
}

export const STATE_TTL_SECONDS = 600;
const STATE_PURPOSE = 'oauth-state-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function isSecureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

/** The configured OAuth client, or null when OAuth is not set up on this deployment. */
export function oauthConfig(env: OAuthEnv): OAuthConfig | null {
  const clientId = env.CF_OAUTH_CLIENT_ID?.trim();
  const authorizeUrl = env.CF_OAUTH_AUTHORIZE_URL?.trim();
  const tokenUrl = env.CF_OAUTH_TOKEN_URL?.trim();
  if (!clientId || !authorizeUrl || !tokenUrl) return null;
  const revokeUrl = env.CF_OAUTH_REVOKE_URL?.trim() || undefined;
  for (const [name, url] of [['CF_OAUTH_AUTHORIZE_URL', authorizeUrl], ['CF_OAUTH_TOKEN_URL', tokenUrl], ['CF_OAUTH_REVOKE_URL', revokeUrl]] as const) {
    if (url && !isSecureUrl(url)) throw new OAuthConfigError(`${name} must be an https URL`);
  }
  const scopes = (env.CF_OAUTH_SCOPES ?? '').split(/[\s,]+/).filter(Boolean);
  return { clientId, authorizeUrl, tokenUrl, revokeUrl, scopes };
}

/** The callback URL registered with Cloudflare. https only (localhost excepted). */
export function redirectUri(env: OAuthEnv, requestUrl: string): string {
  const uri = env.CF_OAUTH_REDIRECT_URI?.trim() || `${new URL(requestUrl).origin}/api/cloudflare/oauth/callback`;
  if (!isSecureUrl(uri)) throw new OAuthConfigError('the OAuth redirect URI must be https');
  return uri;
}

// ── PKCE ───────────────────────────────────────────────────

export function newVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ── State ──────────────────────────────────────────────────

/** What a state is bound to: checked again when it comes back. */
export interface StateBinding {
  workspaceId: string;
  userId: string;
  /** Random per start; also set as an HttpOnly cookie so only the browser that started the flow can finish it. */
  nonce: string;
}

interface StatePayload {
  v: 1;
  a: string;
  u: string;
  n: string;
  /** Expiry, unix seconds. */
  e: number;
  /** The PKCE verifier, sealed. */
  p: string;
  /** Label for the connection being created. */
  l?: string;
  /** Where to send the browser afterwards (a path on this origin). */
  r?: string;
  /** Reconnect: the existing connection whose token this flow replaces. */
  c?: string;
}

export interface StateContent { label?: string; returnTo?: string; connectionId?: string }

const nonceAad = (nonce: string) => `oauth-state|${nonce}`;

export async function signState(
  crypt: TokenCrypto,
  binding: StateBinding,
  verifier: string,
  content: StateContent,
  nowSeconds: number,
): Promise<string> {
  const payload: StatePayload = {
    v: 1,
    a: binding.workspaceId,
    u: binding.userId,
    n: binding.nonce,
    e: nowSeconds + STATE_TTL_SECONDS,
    p: await crypt.seal({ access: verifier }, nonceAad(binding.nonce)),
    l: content.label,
    r: content.returnTo,
    c: content.connectionId,
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await crypt.hmacKey(STATE_PURPOSE), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Verify signature, expiry and binding; returns the verifier and the carried content. */
export async function verifyState(
  crypt: TokenCrypto,
  state: string,
  expected: StateBinding,
  nowSeconds: number,
): Promise<{ verifier: string } & StateContent> {
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new OAuthStateError('malformed');
  let sig: Uint8Array;
  try { sig = unb64url(parts[1]); } catch { throw new OAuthStateError('malformed'); }
  const ok = await crypto.subtle.verify('HMAC', await crypt.hmacKey(STATE_PURPOSE), sig as BufferSource, enc.encode(parts[0]));
  if (!ok) throw new OAuthStateError('signature');
  let p: StatePayload;
  try { p = JSON.parse(dec.decode(unb64url(parts[0]))); } catch { throw new OAuthStateError('malformed'); }
  if (p.v !== 1 || typeof p.e !== 'number' || typeof p.p !== 'string') throw new OAuthStateError('malformed');
  if (p.e <= nowSeconds) throw new OAuthStateError('expired');
  if (p.a !== expected.workspaceId || p.u !== expected.userId || p.n !== expected.nonce) throw new OAuthStateError('mismatch');
  let verifier: string;
  try { verifier = (await crypt.open(p.p, nonceAad(p.n))).access(); } catch { throw new OAuthStateError('malformed'); }
  return { verifier, label: p.l, returnTo: p.r, connectionId: p.c };
}

/** The nonce a signed state carries, for matching the browser cookie before full verification. Unverified. */
export function peekNonce(state: string): string | null {
  try {
    const p = JSON.parse(dec.decode(unb64url(state.split('.')[0]))) as { n?: unknown };
    return typeof p.n === 'string' ? p.n : null;
  } catch {
    return null;
  }
}

/** Only paths on this origin: `/settings` yes; `//evil.test`, `https://…`, `/\evil` no. */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) return undefined;
  return value;
}

// ── Authorize URL ──────────────────────────────────────────

export function buildAuthorizeUrl(cfg: OAuthConfig, p: { redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  if (cfg.scopes.length) u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// ── Token endpoint ─────────────────────────────────────────

export interface OAuthTokens {
  material: TokenMaterial;
  scopes: string[];
}

type Fetch = typeof fetch;

async function postForm(url: string, form: Record<string, string>, doFetch: Fetch): Promise<{ status: number; ok: boolean; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    // Network failure: says nothing about the grant, so not permanent.
    throw new OAuthError('the authorization server could not be reached', undefined, false);
  }
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, data };
}

function failure(r: { status: number; data: Record<string, unknown> }, what: string): OAuthError {
  const code = typeof r.data.error === 'string' ? r.data.error : undefined;
  const permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
  return new OAuthError(`${what} failed${code ? ` (${code})` : ` (HTTP ${r.status})`}`, code, permanent, r.status);
}

function parseTokens(data: Record<string, unknown>, nowSeconds: number, fallbackRefresh?: string): OAuthTokens {
  const access = data.access_token;
  if (typeof access !== 'string' || !access) throw new OAuthError('the authorization server returned no access token', undefined, false);
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined;
  const refresh = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : fallbackRefresh;
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
  return {
    material: new TokenMaterial({ access, refresh, expiresAt: expiresIn !== undefined ? nowSeconds + expiresIn : undefined }),
    scopes,
  };
}

/** Redeem an authorization code with its PKCE verifier. */
export async function exchangeCode(
  cfg: OAuthConfig,
  p: { code: string; verifier: string; redirectUri: string },
  doFetch: Fetch,
  nowSeconds: number,
): Promise<OAuthTokens> {
  const r = await postForm(cfg.tokenUrl, {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: cfg.clientId,
    code_verifier: p.verifier,
  }, doFetch);
  if (!r.ok) throw failure(r, 'exchanging the authorization code');
  return parseTokens(r.data, nowSeconds);
}

/** Trade a refresh token for new tokens. The server may rotate the refresh token; if it does not, the old one is kept. */
export async function refreshTokens(cfg: OAuthConfig, refreshToken: string, doFetch: Fetch, nowSeconds: number): Promise<OAuthTokens> {
  const r = await postForm(cfg.tokenUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId }, doFetch);
  if (!r.ok) throw failure(r, 'refreshing the access token');
  return parseTokens(r.data, nowSeconds, refreshToken);
}

/** RFC 7009 revocation. Resolves true when the server accepted it. */
export async function revokeToken(cfg: OAuthConfig, token: string, hint: 'refresh_token' | 'access_token', doFetch: Fetch): Promise<boolean> {
  if (!cfg.revokeUrl) return false;
  try {
    const r = await postForm(cfg.revokeUrl, { token, token_type_hint: hint, client_id: cfg.clientId }, doFetch);
    return r.ok;
  } catch {
    return false;
  }
}
