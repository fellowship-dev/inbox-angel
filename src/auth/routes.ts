// Unauthenticated /api/auth/* and /api/invites/* routes.
//
// The dashboard's existing endpoints (status, setup, login, logout, forgot, reset, invites)
// keep their shapes but are now thin layers over Better Auth, which they call in-process so
// its rate limiter, password hashing and session handling apply. A short allow-list of Better
// Auth's own endpoints (OAuth, sessions, change-password) is exposed as-is under /api/auth/;
// everything else (notably /sign-up/email, which would bypass the sign-up policy) is not.
import type { BoundEnv as Env } from '../index';
import { authLookups, forAccount, globalQueries, IMPLICIT_ACCOUNT_ID } from '@inbox-angel/db';
import { logAudit, type AuditEntry } from '../audit/log';
import { track } from '../telemetry';
import { TenantContext } from '../tenancy/context';
import { AUTH_BASE_PATH, createAuth, type Auth } from './index';
import { baseUrl, enabledOAuthProviders, isSaas } from './config';
import type { SignupIntent } from './signup-policy';
import { passesCsrfCheck } from './session';
import { verifyTurnstile } from './turnstile';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

/** Set-Cookie values (workers-types predates Headers.getSetCookie). */
const setCookies = (h: Headers): string[] => (h as Headers & { getSetCookie(): string[] }).getSetCookie();

/**
 * Platform-level settings (Turnstile keys, first-run state) live on the implicit account. Nothing
 * tenant-owned is read through this: user data always goes through the caller's own TenantContext.
 */
const platform = (env: Env) => forAccount(env.DB, IMPLICIT_ACCOUNT_ID);

/** Audit an auth event in the account the user acts in (their first membership). */
function auditUser(env: Env, ctx: ExecutionContext, userId: string, entry: AuditEntry, accountId?: string): void {
  ctx.waitUntil((async () => {
    const acct = accountId ?? (await authLookups(env.DB).membershipsOf(userId))[0]?.account_id;
    if (acct) logAudit({ db: env.DB, accountId: acct }, entry);
  })().catch(() => {}));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Better Auth endpoints reachable from outside, as `METHOD /path`. */
const PASSTHROUGH = [
  /^GET \/get-session$/,
  /^POST \/sign-in\/social$/,
  /^GET \/callback\/(github|google)$/,
  /^GET \/error$/,
  /^POST \/sign-out$/,
  /^GET \/list-sessions$/,
  /^POST \/revoke-session$/,
  /^POST \/revoke-sessions$/,
  /^POST \/revoke-other-sessions$/,
  /^POST \/change-password$/,
];

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw { status: 400, message: 'Invalid JSON body' };
  }
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Calls a Better Auth endpoint in-process, as if the browser had. */
function callAuth(
  auth: Auth,
  env: Env,
  request: Request,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const origin = baseUrl(env, new URL(request.url).origin);
  // Pass the caller's real Origin through so Better Auth's own origin check sees it (not ours).
  const headers = new Headers({ origin: request.headers.get('origin') ?? origin, 'content-type': 'application/json', ...init.headers });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  const ua = request.headers.get('user-agent');
  if (ua) headers.set('user-agent', ua);
  return auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
}

/** Better Auth's error → our `{ error }` shape, keeping its status. */
async function authError(res: Response, fallback: string): Promise<Response> {
  const body = await res.json().catch(() => null) as { message?: string } | null;
  const status = res.status === 429 ? 429 : res.status >= 500 ? 500 : res.status;
  const message = status === 429 ? 'Too many requests — try again later' : (body?.message ?? fallback);
  const out = json({ error: message }, status);
  const retry = res.headers.get('retry-after') ?? res.headers.get('x-retry-after');
  if (retry) out.headers.set('retry-after', retry);
  return out;
}

/** The session response → `{ token }` for the dashboard, plus the session cookie for browsers. */
function sessionResponse(res: Response, body: Record<string, unknown>, status = 200): Response {
  const token = res.headers.get('set-auth-token');
  const out = json({ token, ...body }, status);
  for (const cookie of setCookies(res.headers)) out.headers.append('set-cookie', cookie);
  return out;
}

async function limited(env: Env, request: Request): Promise<boolean> {
  if (!env.AUTH_LIMITER) return false;
  const { success } = await env.AUTH_LIMITER.limit({ key: clientIp(request) });
  return !success;
}

async function turnstileFails(env: Env, request: Request, token: string | undefined): Promise<boolean> {
  const secret = await platform(env).settings.get('turnstile_secret_key');
  if (!secret?.value) return false;
  if (!token) return true;
  return !(await verifyTurnstile(token, secret.value, request.headers.get('CF-Connecting-IP') ?? ''));
}

/** Creates a user through Better Auth under the given sign-up intent and returns its session response. */
async function signUp(
  env: Env, request: Request, ctx: ExecutionContext, intent: SignupIntent,
  p: { name: string; email: string; password: string },
): Promise<{ res: Response; user?: { id: string; email: string } }> {
  const auth = await createAuth(env, request, { intent, ctx });
  const res = await callAuth(auth, env, request, '/sign-up/email', { body: p });
  if (!res.ok) return { res };
  const data = await res.clone().json() as { user?: { id: string; email: string } };
  return { res, user: data.user };
}

export async function handleAuthRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!path.startsWith('/api/auth/') && !path.startsWith('/api/invites/')) return null;

  // Login-CSRF defence: every POST must be same-origin (when a browser says where it came from)
  // and, apart from body-less logout, explicit JSON — a cross-site <form> can only send text/plain.
  if (method === 'POST') {
    if (!passesCsrfCheck(request, env, { allowNonBrowser: true })) return err('cross-origin request rejected', 403);
    const ct = request.headers.get('content-type') ?? '';
    if (path !== '/api/auth/logout' && !/^application\/json\b/i.test(ct)) return err('Content-Type must be application/json', 415);
  }

  // ── GET /api/auth/status ────────────────────────────────────
  if (path === '/api/auth/status' && method === 'GET') {
    const saas = isSaas(env);
    const configured = saas ? true : await platform(env).team.hasOwner();
    const [tsKeyRow, customDomainRow, telemetryRow] = await Promise.all([
      platform(env).settings.get('turnstile_site_key'),
      platform(env).settings.get('custom_domain'),
      platform(env).settings.get('telemetry_opted_in'),
    ]);
    // First-run facts about the platform's own (implicit) account; hosted signups have none of this yet.
    const existingDomains = saas ? [] : await platform(env).domains.list();
    const baseDomain = saas ? undefined : (await platform(env).settings.get('base_domain'))?.value;
    return json({
      configured,
      mode: saas ? 'saas' : 'self-host',
      signup_open: saas,
      oauth_providers: enabledOAuthProviders(env),
      prefill: { name: '', email: '' },
      telemetry_default: telemetryRow?.value === 'true',
      turnstile_site_key: tsKeyRow?.value ?? null,
      custom_domain: customDomainRow?.value ?? null,
      base_domain: baseDomain ?? null,
      has_domain: existingDomains.length > 0 || !!baseDomain,
    });
  }

  // ── POST /api/auth/setup — first-run owner (self-host; closed once an owner exists) ──
  // ── POST /api/auth/signup — new account (MODE=saas) ─────────
  if ((path === '/api/auth/setup' || path === '/api/auth/signup') && method === 'POST') {
    const isSetup = path === '/api/auth/setup';
    const ip = clientIp(request);
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    if (isSetup && isSaas(env)) return err('sign up at /api/auth/signup', 409);
    if (!isSetup && !isSaas(env)) return err('sign-up is closed — ask an owner for an invite', 403);
    if (isSetup && (await platform(env).team.hasOwner())) return err('already configured — use /api/auth/login', 409);

    const body = await readJson<{ name?: string; email?: string; password?: string; telemetry?: boolean; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (!EMAIL_RE.test(body.email)) return err('invalid email', 400);
    if (await turnstileFails(env, request, body.cf_turnstile_token)) return err('Bot check failed', 403);

    const email = body.email.toLowerCase().trim();
    const { res, user } = await signUp(env, request, ctx, { kind: isSetup ? 'setup' : 'signup' }, {
      name: body.name?.trim() || email, email, password: body.password,
    });
    if (!res.ok || !user) return authError(res, 'sign-up failed');

    if (isSetup && body.telemetry !== undefined) await platform(env).settings.set('telemetry_opted_in', body.telemetry ? 'true' : 'false');
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: email, actor_type: 'user',
      action: isSetup ? 'auth.setup' : 'auth.signup',
      resource_type: 'user', resource_id: user.id, resource_name: email,
      after_value: { email, role: 'owner' },
      meta: { ip },
    });
    if (isSetup) track(new TenantContext({ env, accountId: IMPLICIT_ACCOUNT_ID }), { event: 'instance.born' }); // fire-and-forget

    const hasDomain = !isSetup ? false
      : (await platform(env).domains.list()).length > 0 || !!(await platform(env).settings.get('base_domain'))?.value;
    return sessionResponse(res, { has_domain: hasDomain }, 201);
  }

  // ── POST /api/auth/login ────────────────────────────────────
  if (path === '/api/auth/login' && method === 'POST') {
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const body = await readJson<{ email?: string; password?: string; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (await turnstileFails(env, request, body.cf_turnstile_token)) return err('Bot check failed', 403);

    const auth = await createAuth(env, request, { ctx });
    const res = await callAuth(auth, env, request, '/sign-in/email', { body: { email: body.email.toLowerCase().trim(), password: body.password } });
    if (!res.ok) return res.status === 429 ? authError(res, 'too many requests') : err('invalid credentials', 401);

    const { user } = await res.clone().json() as { user: { id: string; email: string } };
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: user.email, actor_type: 'user',
      action: 'auth.login',
      resource_type: 'user', resource_id: user.id, resource_name: user.email,
      meta: { ip: request.headers.get('CF-Connecting-IP') ?? 'unknown' },
    });
    return sessionResponse(res, {});
  }

  // ── POST /api/auth/logout ───────────────────────────────────
  if (path === '/api/auth/logout' && method === 'POST') {
    const key = request.headers.get('x-api-key') ?? '';
    const headers: Record<string, string> = {};
    const cookie = request.headers.get('cookie');
    if (cookie) headers.cookie = cookie;
    if (key) headers.authorization = `Bearer ${key}`;
    const auth = await createAuth(env, request, { ctx });
    const res = await callAuth(auth, env, request, '/sign-out', { headers, body: {} });
    const out = json({ ok: true });
    for (const c of setCookies(res.headers)) out.headers.append('set-cookie', c);
    return out;
  }

  // ── POST /api/auth/forgot — always the same answer, whether or not the email exists ──
  if (path === '/api/auth/forgot' && method === 'POST') {
    const body = await readJson<{ email?: string }>(request);
    if (!body.email) return err('email is required', 400);
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const email = body.email.toLowerCase().trim();
    const auth = await createAuth(env, request, { ctx });
    // Rate-limited per IP inside Better Auth; its answer is deliberately ignored.
    const res = await callAuth(auth, env, request, '/request-password-reset', { body: { email } });
    if (res.status === 429) return authError(res, 'too many requests');
    ctx.waitUntil(globalQueries(env.DB).users.byEmail(email).then(user => {
      if (user) auditUser(env, ctx, user.id, {
        actor_id: user.id, actor_email: user.email, actor_type: 'user',
        action: 'auth.password_reset', resource_type: 'user', resource_id: user.id, resource_name: user.email,
        meta: { phase: 'requested' },
      });
    }).catch(() => {}));
    return json({ ok: true });
  }

  // ── POST /api/auth/reset — set a new password with the emailed token ──
  if (path === '/api/auth/reset' && method === 'POST') {
    const body = await readJson<{ token?: string; password?: string }>(request);
    if (!body.token || !body.password) return err('token and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (await limited(env, request)) return err('Too many requests — try again later', 429);

    const userId = await globalQueries(env.DB).verifications.resetTokenUser(body.token, Math.floor(Date.now() / 1000));
    if (!userId) return err('reset link is invalid or has expired', 400);
    const user = await globalQueries(env.DB).users.byId(userId);
    if (!user) return err('reset link is invalid or has expired', 400);

    const auth = await createAuth(env, request, { ctx });
    const reset = await callAuth(auth, env, request, '/reset-password', { body: { newPassword: body.password, token: body.token } });
    if (!reset.ok) return reset.status === 429 ? authError(reset, 'too many requests') : err('reset link is invalid or has expired', 400);
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: user.email, actor_type: 'user',
      action: 'auth.password_reset', resource_type: 'user', resource_id: user.id,
      meta: { phase: 'completed' },
    });

    // Resetting revokes every session; start a fresh one so the dashboard can carry on.
    const login = await callAuth(auth, env, request, '/sign-in/email', { body: { email: user.email, password: body.password } });
    return login.ok ? sessionResponse(login, {}) : json({ token: null });
  }

  // ── Invites: GET info, POST accept ──────────────────────────
  const inviteMatch = path.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteMatch && (method === 'GET' || method === 'POST')) {
    const invite = await authLookups(env.DB).inviteByToken(inviteMatch[1]);
    if (!invite || invite.used_at || invite.expires_at < Math.floor(Date.now() / 1000)) {
      return err('invite not found or expired', 404);
    }
    if (method === 'GET') return json({ email: invite.email, invited_by: invite.invited_by, role: invite.role });

    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const body = await readJson<{ name?: string; password?: string }>(request);
    if (!body.name || !body.password) return err('name and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (await globalQueries(env.DB).users.byEmail(invite.email)) return err('an account with this email already exists', 409);

    const { res, user } = await signUp(env, request, ctx, { kind: 'invite', token: invite.token }, {
      name: body.name.trim(), email: invite.email, password: body.password,
    });
    if (!res.ok || !user) return authError(res, 'could not accept invite');
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: invite.email, actor_type: 'user',
      action: 'auth.invite_accepted',
      resource_type: 'user', resource_id: user.id, resource_name: invite.email,
      after_value: { email: invite.email, role: invite.role, invited_by: invite.invited_by },
    }, invite.account_id);
    return sessionResponse(res, {}, 201);
  }

  // ── Better Auth's own endpoints: OAuth, sessions, change-password ──
  if (path.startsWith(`${AUTH_BASE_PATH}/`)) {
    const rel = path.slice(AUTH_BASE_PATH.length);
    if (!PASSTHROUGH.some(re => re.test(`${method} ${rel}`))) return err('not found', 404);
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const auth = await createAuth(env, request, { ctx });
    // The dashboard holds its session token in X-Api-Key; Better Auth reads it as a Bearer token.
    const headers = new Headers(request.headers);
    const key = headers.get('x-api-key');
    if (key && !headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
    let body: BodyInit | null = method === 'GET' ? null : await request.text();
    if (method === 'POST' && rel === '/change-password') {
      // A password change always signs out every other session; the caller cannot opt out.
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body as string); } catch { return err('Invalid JSON body', 400); }
      body = JSON.stringify({ ...parsed, revokeOtherSessions: true });
    }
    return auth.handler(new Request(request.url, { method, headers, body }));
  }

  return null;
}
