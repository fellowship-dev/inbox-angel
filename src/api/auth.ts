// Request authentication for /api/*. The work is in src/auth/session.ts; this is the
// seam the router (and its tests) call.
import { authenticate, passesCsrfCheck, AuthError, type Principal } from '../auth/session';
import type { AuthEnv } from '../auth/config';

export { AuthError };
export type { AuthEnv };

/** What a route handler needs to know about the caller. */
export interface AuthContext {
  /** The user's id; 'instance' for the deprecated API_KEY. */
  userId: string;
  workspaceId: string;
  role: Principal['role'];
  kind: Principal['kind'];
  user: Principal['user'];
  apiKeyId?: string;
}

/**
 * Verifies the caller. Returns who they are and their role on success; throws AuthError
 * (401 unauthenticated, 403 forbidden) otherwise.
 */
export async function requireAuth(
  request: Request,
  env: AuthEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<AuthContext> {
  const principal = await authenticate(request, env, ctx);
  if (!principal) throw new AuthError('Unauthorized — sign in, or provide an X-Api-Key header');
  if (principal.viaCookie && !passesCsrfCheck(request, env)) {
    throw new AuthError('cross-origin request rejected', 403);
  }
  return {
    userId: principal.user?.id ?? 'instance',
    workspaceId: principal.workspaceId,
    role: principal.role,
    kind: principal.kind,
    user: principal.user,
    apiKeyId: principal.apiKeyId,
  };
}
