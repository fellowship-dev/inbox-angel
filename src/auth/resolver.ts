// Session-based WorkspaceResolver: credential → user → membership → workspace.
//
// This is the resolver the router uses by default (see defaultResolver in src/tenancy/resolver.ts),
// so every request's TenantContext is built from it:
//   the caller acts in the workspace named by X-Workspace-Id (a membership is required), else their oldest one.
// It goes through requireAuth, so the CSRF check for cookie sessions applies, and a missing or
// invalid credential is `null` (unauthenticated), never a default workspace.
import type { Env } from '../index';
import { AuthError } from './session';
import { requireAuth, type AuthContext } from '../api/auth';
import type { WorkspaceResolver, ResolvedWorkspace } from '../tenancy/resolver';

/** What this resolver adds to the tenancy seam: how the caller authenticated. */
export interface AuthedWorkspace extends ResolvedWorkspace {
  kind?: AuthContext['kind'];
}

export const sessionWorkspaceResolver: WorkspaceResolver = async (request: Request, env: Env): Promise<AuthedWorkspace | null> => {
  let who: AuthContext;
  try {
    who = await requireAuth(request, env);
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) return null; // no valid credential
    throw e; // 403: valid credential, not allowed (no membership, cross-site cookie write, …)
  }
  return {
    access: who.access,
    workspaceId: who.workspaceId,
    // The instance API_KEY belongs to no user.
    userId: who.kind === 'instance' ? undefined : who.userId,
    role: who.role,
    kind: who.kind,
  };
};
