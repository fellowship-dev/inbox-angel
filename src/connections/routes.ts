// /api/cloudflare/* — Cloudflare connections of the caller's workspace. Documented in docs/cloudflare-oauth.md.
//
//   GET    /api/cloudflare/connections                    connections + what this deployment offers (OAuth, pasted tokens)
//   POST   /api/cloudflare/connections                    { token, label? }  add a pasted API token (verified with Cloudflare first)
//   GET    /api/cloudflare/connections/:id                one connection
//   PUT    /api/cloudflare/connections/:id/token          { token }  give a broken pasted-token connection a new token
//   DELETE /api/cloudflare/connections/:id                disconnect (OAuth: revoke at Cloudflare first)
//   GET    /api/cloudflare/connections/:id/zones          every zone the connection can see, with `allowed`
//   PUT    /api/cloudflare/connections/:id/zones          { zone_ids }  replace the allow-list
//   POST   /api/cloudflare/oauth/start                    { label?, return_to?, connection_id? } → { authorize_url }
//   GET    /api/cloudflare/oauth/callback                 Cloudflare sends the browser here; redirects to return_to
//   PUT    /api/domains/:id/connection                    { connection_id | null }  link a domain to the connection that manages its zone
//
// Everything needs an owner or admin (reads too: the list shows workspace names and scopes), and acts on the
// caller's workspace only: another workspace's connection or domain id is a 404.

import type { TenantContext } from '../tenancy/context';
import {
  CfAuthError,
  CfConnectionError,
  CfZoneNotAllowedError,
  CfZoneNotFoundError,
} from '../tenancy/cf-client';
import { logAudit } from '../audit/log';
import { getMode } from '../tenancy/mode';
import { TokenCrypto, TokenEnvelopeError, TokenKeyError } from './crypto';
import {
  OAuthConfigError,
  OAuthError,
  OAuthStateError,
  STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  challengeFor,
  exchangeCode,
  newVerifier,
  oauthConfig,
  peekNonce,
  randomId,
  redirectUri,
  safeReturnTo,
  signState,
  verifyState,
} from './oauth';
import { ConnectionInputError, IMPLICIT_CONNECTION_ID, type PublicConnection } from './service';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);

const USED_PREFIX = 'cf_oauth_used:';
const COOKIE = 'ia_cf_oauth';
const COOKIE_PATH = '/api/cloudflare/oauth';
const CONNECTION = /^\/api\/cloudflare\/connections\/([^/]+)(?:\/(token|zones))?$/;
const DOMAIN_LINK = /^\/api\/domains\/(\d+)\/connection$/;

export const isConnectionRoute = (path: string) => path.startsWith('/api/cloudflare/') || DOMAIN_LINK.test(path);

export interface ConnectionCaller {
  role?: string;
  user: { id: string; email: string } | null;
}

export interface ConnectionDeps {
  now?: () => number;
}

export async function handleConnectionRoutes(
  request: Request,
  tenant: TenantContext,
  ctx: ExecutionContext,
  caller: ConnectionCaller,
  deps: ConnectionDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isConnectionRoute(path)) return null;
  const method = request.method.toUpperCase();
  if (caller.role !== 'owner' && caller.role !== 'admin') return err('admin required', 403);

  const now = () => (deps.now ? deps.now() : Math.floor(Date.now() / 1000));
  const svc = tenant.connections;
  const audit = (action: string, resource: { id: string; name?: string }, extra: { before?: unknown; after?: unknown } = {}) =>
    logAudit(tenant, {
      actor_id: caller.user?.id ?? null, actor_email: caller.user?.email ?? null, actor_type: 'user',
      action, resource_type: 'cf_connection', resource_id: resource.id, resource_name: resource.name,
      before_value: extra.before, after_value: extra.after,
    }, ctx);

  try {
    // ── OAuth ───────────────────────────────────────────────
    if (path === '/api/cloudflare/oauth/start' && method === 'POST') {
      const cfg = oauthConfig(tenant.env);
      if (!cfg) return err('Cloudflare OAuth is not configured on this deployment', 404, 'oauth_not_configured');
      if (!caller.user) return err('connect Cloudflare while signed in as a user', 403);
      let body: { label?: unknown; return_to?: unknown; connection_id?: unknown } = {};
      try { body = request.headers.get('content-length') === '0' ? {} : await request.json(); } catch { return err('Invalid JSON body', 400); }
      let connectionId: string | undefined;
      if (body.connection_id !== undefined) {
        if (typeof body.connection_id !== 'string' || !(await tenant.scope.connections.get(body.connection_id))) return err('connection not found', 404);
        connectionId = body.connection_id;
      }
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) || undefined : undefined;

      const crypt = svc.crypt;
      const verifier = newVerifier();
      const nonce = randomId();
      const state = await signState(
        crypt,
        { workspaceId: tenant.workspaceId, userId: caller.user.id, nonce },
        verifier,
        { label, returnTo: safeReturnTo(body.return_to), connectionId },
        now(),
      );
      const challenge = await challengeFor(verifier);
      const relay = relayBase(tenant.env);
      const authorizeUrl = relay
        ? `${relay}/relay/start?${new URLSearchParams({ cb: callbackUri(tenant, request), state, challenge })}`
        : buildAuthorizeUrl(cfg, { redirectUri: redirectUri(tenant.env, request.url), state, challenge });

      const res = json({ authorize_url: authorizeUrl, expires_in: 600 });
      res.headers.append('Set-Cookie', cookie(nonce, 600, url.protocol === 'https:'));
      return res;
    }

    if (path === '/api/cloudflare/oauth/callback' && method === 'GET') {
      return await oauthCallback(request, tenant, ctx, caller, now(), audit);
    }

    // ── Domain link ─────────────────────────────────────────
    const link = path.match(DOMAIN_LINK);
    if (link && method === 'PUT') {
      const domain = await tenant.scope.domains.getById(parseInt(link[1], 10));
      if (!domain) return err('domain not found', 404);
      let body: { connection_id?: unknown };
      try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
      const target = body.connection_id;
      if (target !== null && typeof target !== 'string') return err('connection_id must be a connection id or null', 400);

      // null (or the implicit env connection) means "no stored connection": the self-host token, if any.
      if (target === null || target === IMPLICIT_CONNECTION_ID) {
        await tenant.scope.domains.setConnection(domain.id, null);
        tenant.invalidate();
        audit('domain.cf_connection', { id: String(domain.id), name: domain.domain }, { before: { connection_id: domain.cf_connection_id }, after: { connection_id: null } });
        return json({ ok: true, domain_id: domain.id, connection_id: null });
      }
      const conn = await svc.get(target);
      if (!conn) return err('connection not found', 404);
      if (conn.status !== 'active') return err(`connection "${conn.label}" is ${conn.status}: reconnect it first`, 409, `cf_connection_${conn.status}`);
      // The connection must manage this domain's zone, and the owner must have allowed that zone.
      try {
        await (await svc.clientFor(target)).zoneFor(domain.domain);
      } catch (e) {
        if (e instanceof CfZoneNotAllowedError && e.kind === 'shadow') return err(e.message, 400, 'cf_zone_not_allowed');
        if (e instanceof CfZoneNotAllowedError) return err(`the zone of ${domain.domain} is not in this connection's allow-list: allow it first`, 400, 'cf_zone_not_allowed');
        if (e instanceof CfZoneNotFoundError) return err(`this Cloudflare account has no zone for ${domain.domain}`, 400, 'cf_zone_not_found');
        throw e;
      }
      await tenant.scope.domains.setConnection(domain.id, target);
      tenant.invalidate();
      audit('domain.cf_connection', { id: String(domain.id), name: domain.domain }, { before: { connection_id: domain.cf_connection_id }, after: { connection_id: target } });
      return json({ ok: true, domain_id: domain.id, connection_id: target });
    }

    // ── Connections ─────────────────────────────────────────
    if (path === '/api/cloudflare/connections' && method === 'GET') {
      const connections: PublicConnection[] = await svc.list();
      const implicit = implicitConnection(tenant);
      if (implicit) connections.unshift(implicit);
      return json({
        connections,
        oauth: oauthOffer(tenant),
        token_paste: TokenCrypto.isConfigured(tenant.env),
        encryption_configured: TokenCrypto.isConfigured(tenant.env),
      });
    }

    if (path === '/api/cloudflare/connections' && method === 'POST') {
      let body: { token?: unknown; label?: unknown };
      try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
      if (typeof body.token !== 'string' || body.token.trim().length < 20) return err('token is required', 400);
      const created = await svc.addToken({ token: body.token.trim(), label: typeof body.label === 'string' ? body.label : undefined, createdBy: caller.user?.id });
      audit('cf_connection.create', { id: created.id, name: created.label }, { after: { auth_type: 'token', cf_account_id: created.cf_account_id } });
      tenant.setHasConnections(true);
      return json({ connection: created }, 201);
    }

    const m = path.match(CONNECTION);
    if (m) {
      const [, id, sub] = m;
      if (id === IMPLICIT_CONNECTION_ID) {
        const implicit = implicitConnection(tenant);
        if (!sub && method === 'GET' && implicit) return json({ connection: implicit });
        return err(implicit ? 'the CLOUDFLARE_API_TOKEN connection is configured on the server and cannot be changed here' : 'connection not found', implicit ? 400 : 404);
      }

      if (!sub && method === 'GET') {
        const c = await svc.get(id);
        return c ? json({ connection: c }) : err('connection not found', 404);
      }

      if (!sub && method === 'DELETE') {
        const before = await svc.get(id);
        const result = await svc.disconnect(id);
        if (!before || !result) return err('connection not found', 404);
        audit('cf_connection.delete', { id, name: before.label }, { before: { auth_type: before.auth_type, status: before.status, cf_account_id: before.cf_account_id }, after: { revoked_remote: result.revokedRemote, unlinked_domains: result.unlinkedDomains } });
        tenant.invalidate();
        return json({ ok: true, revoked_remote: result.revokedRemote, unlinked_domains: result.unlinkedDomains });
      }

      if (sub === 'token' && method === 'PUT') {
        let body: { token?: unknown };
        try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
        if (typeof body.token !== 'string' || body.token.trim().length < 20) return err('token is required', 400);
        const c = await svc.replaceToken(id, body.token.trim());
        audit('cf_connection.reconnect', { id, name: c.label });
        tenant.invalidate();
        return json({ connection: c });
      }

      if (sub === 'zones' && method === 'GET') {
        if (!(await svc.get(id))) return err('connection not found', 404);
        return json({ zones: (await svc.availableZones(id)).map(({ id: zid, name, allowed }) => ({ id: zid, name, allowed })) });
      }

      if (sub === 'zones' && method === 'PUT') {
        const before = await svc.get(id);
        if (!before) return err('connection not found', 404);
        let body: { zone_ids?: unknown };
        try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
        if (!Array.isArray(body.zone_ids) || body.zone_ids.some(z => typeof z !== 'string') || body.zone_ids.length > 500) return err('zone_ids must be an array of zone ids', 400);
        const zones = await svc.setAllowedZones(id, body.zone_ids as string[]);
        audit('cf_connection.zones', { id, name: before.label }, { before: { zones: before.zones.map(z => z.name) }, after: { zones: zones.map(z => z.name) } });
        tenant.invalidate();
        return json({ zones });
      }
      return err('method not allowed', 405);
    }

    return err('not found', 404);
  } catch (e) {
    return connectionFailure(e);
  }
}

// ── OAuth callback ────────────────────────────────────────

async function oauthCallback(
  request: Request,
  tenant: TenantContext,
  _ctx: ExecutionContext,
  caller: ConnectionCaller,
  nowSeconds: number,
  audit: (action: string, resource: { id: string; name?: string }, extra?: { before?: unknown; after?: unknown }) => void,
): Promise<Response> {
  const url = new URL(request.url);
  const cfg = oauthConfig(tenant.env);
  if (!cfg) return err('Cloudflare OAuth is not configured on this deployment', 404, 'oauth_not_configured');
  if (!caller.user) return err('connect Cloudflare while signed in as a user', 403);

  const state = url.searchParams.get('state') ?? '';
  const cookieNonce = readCookie(request, COOKIE);
  const stateNonce = peekNonce(state);
  // The browser that finishes the flow must be the one that started it.
  if (!cookieNonce || !stateNonce || cookieNonce !== stateNonce) {
    return clearCookie(err('this connection attempt was not started in this browser (or has expired): start again', 400, 'oauth_state_mismatch'), request);
  }

  const crypt = tenant.connections.crypt;
  let verified;
  try {
    verified = await verifyState(crypt, state, { workspaceId: tenant.workspaceId, userId: caller.user.id, nonce: stateNonce }, nowSeconds);
  } catch (e) {
    if (e instanceof OAuthStateError) return clearCookie(err('invalid or expired state: start again', 400, `oauth_state_${e.reason}`), request);
    throw e;
  }

  // Single use: the state is spent the moment it verifies, whatever happens next (a replayed callback, a second
  // tab, a code that fails to exchange all need a fresh start). The marker lives until the state would have expired.
  const q = tenant.scope.settings;
  await q.deleteExpired(USED_PREFIX, nowSeconds);
  if (!(await q.claim(`${USED_PREFIX}${stateNonce}`, String(nowSeconds + STATE_TTL_SECONDS + 60)))) {
    return clearCookie(err('this connection attempt was already used: start again', 400, 'oauth_state_used'), request);
  }

  const back = (params: Record<string, string>) => clearCookie(redirectBack(request, verified.returnTo, params), request);

  const denied = url.searchParams.get('error');
  if (denied) return back({ cf_error: sanitizeCode(denied) });
  const code = url.searchParams.get('code');
  if (!code) return back({ cf_error: 'invalid_request' });

  try {
    const relay = relayBase(tenant.env);
    const tokens = await exchangeCode(
      cfg,
      { code, verifier: verified.verifier, redirectUri: relay ? `${relay}/relay/callback` : redirectUri(tenant.env, request.url) },
      (i, init) => globalThis.fetch(i, init),
      nowSeconds,
    );
    const connection = await tenant.connections.addOAuth({ tokens, label: verified.label, createdBy: caller.user.id, replace: verified.connectionId });
    audit(verified.connectionId ? 'cf_connection.reconnect' : 'cf_connection.create', { id: connection.id, name: connection.label }, { after: { auth_type: 'oauth', cf_account_id: connection.cf_account_id, scopes: connection.scopes } });
    tenant.setHasConnections(true);
    tenant.invalidate();
    return back({ cf_connection: connection.id });
  } catch (e) {
    if (e instanceof OAuthError) return back({ cf_error: sanitizeCode(e.code ?? 'token_exchange_failed') });
    if (e instanceof ConnectionInputError) return back({ cf_error: sanitizeCode(e.code ?? 'invalid_request') });
    if (e instanceof CfConnectionError) return back({ cf_error: 'connection_not_found' });
    throw e;
  }
}

// ── helpers ───────────────────────────────────────────────

function relayBase(env: { CF_OAUTH_RELAY_URL?: string }): string | null {
  const v = env.CF_OAUTH_RELAY_URL?.trim().replace(/\/+$/, '');
  return v || null;
}

/** This instance's own callback, which the relay forwards the browser to. */
function callbackUri(tenant: TenantContext, request: Request): string {
  const base = tenant.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, '') || new URL(request.url).origin;
  return `${base}/api/cloudflare/oauth/callback`;
}

function oauthOffer(tenant: TenantContext): { available: boolean; scopes: string[]; via_relay: boolean } {
  let cfg = null;
  try { cfg = oauthConfig(tenant.env); } catch { /* misconfigured: not offered */ }
  return {
    available: !!cfg && TokenCrypto.isConfigured(tenant.env),
    scopes: cfg?.scopes ?? [],
    via_relay: relayBase(tenant.env) !== null,
  };
}

/** The self-host CLOUDFLARE_API_TOKEN, shown as an implicit "token" connection. */
function implicitConnection(tenant: TenantContext): PublicConnection | null {
  if (getMode(tenant.env) !== 'selfhost' || !tenant.cf()) return null;
  return {
    id: IMPLICIT_CONNECTION_ID,
    label: 'Server API token (CLOUDFLARE_API_TOKEN)',
    auth_type: 'token',
    status: 'active',
    status_detail: null,
    cf_account_id: tenant.settings.cfAccountId ?? null,
    cf_account_name: null,
    scopes: [],
    created_by: null,
    created_at: 0,
    last_used_at: null,
    zones: [],
    implicit: true,
  };
}

const sanitizeCode = (c: string) => c.replace(/[^a-z0-9_.-]/gi, '').slice(0, 60) || 'error';

function cookie(nonce: string, maxAge: number, secure: boolean): string {
  return `${COOKIE}=${nonce}; Max-Age=${maxAge}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearCookie(res: Response, request: Request): Response {
  const out = new Response(res.body, res);
  out.headers.append('Set-Cookie', cookie('', 0, new URL(request.url).protocol === 'https:'));
  return out;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

function redirectBack(request: Request, returnTo: string | undefined, params: Record<string, string>): Response {
  const [pathAndQuery, hash] = (returnTo ?? '/').split('#');
  const target = new URL(pathAndQuery, new URL(request.url).origin);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: { Location: target.pathname + target.search + (hash ? `#${hash}` : ''), 'Cache-Control': 'no-store' },
  });
}

/** Typed failures → HTTP. Nothing here echoes a token: none of these errors holds one. */
function connectionFailure(e: unknown): Response {
  if (e instanceof ConnectionInputError) return err(e.message, e.status, e.code);
  if (e instanceof TokenKeyError) return err(e.message, 503, 'encryption_not_configured');
  if (e instanceof TokenEnvelopeError) return err('Cloudflare connections are unavailable: the server\'s encryption key does not match the stored credentials. This is for the server operator to fix.', 503, 'token_encryption_unavailable');
  if (e instanceof OAuthConfigError) return err(e.message, 503, 'oauth_misconfigured');
  if (e instanceof OAuthError) return err(e.message, 502, 'oauth_failed');
  if (e instanceof CfConnectionError) {
    if (e.code === 'missing') return err('connection not found', 404);
    return json({ error: e.message, code: `cf_connection_${e.code}`, connection_id: e.connectionId }, 409);
  }
  if (e instanceof CfZoneNotAllowedError) return json({ error: e.message, code: 'cf_zone_not_allowed', connection_id: e.connectionId }, 403);
  if (e instanceof CfAuthError) return err('Cloudflare refused the request: check the token and its permissions', 502, 'cf_auth');
  throw e;
}
