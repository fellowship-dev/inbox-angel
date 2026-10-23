// Resolves "who is calling, and in which workspace, with what role" from a request.
//
// Credentials, in order:
//   1. the deprecated API_KEY env var                    → instance admin (owner of ws_default, no user)
//   2. `X-Api-Key` / `Authorization: Bearer` ia_…        → a per-user API key (its workspace, its owner's current role)
//   3. `X-Api-Key` / `Authorization: Bearer` <token>     → a Better Auth session (the dashboard keeps its token in localStorage)
//   4. the Better Auth session cookie                    → same session, sent by the browser (OAuth sign-in)
import { authLookups, globalQueries, IMPLICIT_WORKSPACE_ID, type MembershipRole } from '@inbox-angel/db';
import { resolveApiKey, looksLikeApiKey } from './api-keys';
import { createAuth } from './index';
import type { AuthEnv } from './config';
import { trustedOrigins } from './config';

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type PrincipalKind = 'instance' | 'api_key' | 'session';

export interface Principal {
  kind: PrincipalKind;
  /** True when the credential was a cookie (so CSRF checks apply). */
  viaCookie: boolean;
  /** Null for the instance API key, which belongs to no one. */
  user: { id: string; email: string; name: string } | null;
  workspaceId: string;
  role: MembershipRole;
  apiKeyId?: string;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time string equality (compares digests, so length does not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function presentedCredential(request: Request): string {
  const key = request.headers.get('x-api-key');
  if (key) return key;
  const auth = request.headers.get('authorization') ?? '';
  return /^bearer /i.test(auth) ? auth.slice(7).trim() : '';
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * State-changing requests must come from our own origin.
 * `allowNonBrowser`: for routes that take no ambient credential to begin with (login, setup…),
 * a request with neither Origin nor Sec-Fetch-Site is a script or curl — browsers always send
 * one of them on cross-site POSTs — so it is let through; a present-but-foreign one is not.
 */
export function passesCsrfCheck(request: Request, env: AuthEnv, opts: { allowNonBrowser?: boolean } = {}): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get('origin');
  if (origin) return trustedOrigins(env, new URL(request.url).origin).includes(origin);
  // No Origin (some same-origin requests): accept only if the browser says it is same-origin.
  const site = request.headers.get('sec-fetch-site');
  if (!site && opts.allowNonBrowser) return true;
  return site === 'same-origin' || site === 'none';
}

/** The signed-in user behind a session token or cookie, whatever workspaces they belong to; null if none. */
async function sessionUser(
  env: AuthEnv,
  request: Request,
  token: string | null,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<{ id: string; email: string; name: string } | null> {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  else {
    const cookie = request.headers.get('cookie');
    if (!cookie) return null;
    headers.set('cookie', cookie);
  }
  const auth = await createAuth(env, request, { ctx });
  const session = await auth.api.getSession({ headers }).catch(() => null);
  return session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
}

/** Who is signed in (session only, no API keys), for routes that care about the person rather than a workspace. */
export async function currentUser(request: Request, env: AuthEnv, ctx?: Pick<ExecutionContext, 'waitUntil'>) {
  const presented = presentedCredential(request);
  if (presented && (looksLikeApiKey(presented) || (env.API_KEY && (await safeEqual(presented, env.API_KEY))))) return null;
  return sessionUser(env, request, presented || null, ctx);
}

async function fromSession(
  env: AuthEnv,
  request: Request,
  token: string | null,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Principal | null> {
  const user = await sessionUser(env, request, token, ctx);
  if (!user) return null;

  const memberships = await authLookups(env.DB as D1Database).membershipsOf(user.id);
  if (memberships.length === 0) throw new AuthError('this user is not a member of any workspace', 403);
  // A user in several workspaces picks one with X-Workspace-Id; otherwise their oldest membership.
  const wanted = request.headers.get('x-workspace-id');
  const chosen = (wanted && memberships.find(m => m.workspace_id === wanted)) || (!wanted ? memberships[0] : null);
  if (!chosen) throw new AuthError('not a member of that workspace', 403);

  return {
    kind: 'session',
    viaCookie: !token,
    user,
    workspaceId: chosen.workspace_id,
    role: chosen.role,
  };
}

/** Resolve the caller, or null if no valid credential was presented. Throws AuthError(403) for a valid user with no usable workspace. */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Principal | null> {
  const presented = presentedCredential(request);

  if (presented && env.API_KEY && (await safeEqual(presented, env.API_KEY))) {
    return { kind: 'instance', viaCookie: false, user: null, workspaceId: IMPLICIT_WORKSPACE_ID, role: 'owner' };
  }
  if (!env.DB) return null;

  if (presented && looksLikeApiKey(presented)) {
    const key = await resolveApiKey(env.DB, presented);
    if (!key ) return null;
    const user = await globalQueries(env.DB).users.byId(key.userId);
    if (!user) return null;
    return {
      kind: 'api_key',
      viaCookie: false,
      user: { id: user.id, email: user.email, name: user.name },
      workspaceId: key.workspaceId,
      role: key.role,
      apiKeyId: key.keyId,
    };
  }
  return fromSession(env, request, presented || null, ctx);
}
