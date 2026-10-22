// Session-based AccountResolver: credential → user → membership → account.
//
// This is the resolver the router uses by default (see defaultResolver in src/tenancy/resolver.ts),
// so every request's TenantContext is built from it:
//   self-host  — the caller always resolves to acct_default (the only account that exists);
//   MODE=saas  — to their own account (X-Account-Id picks among several memberships).
// It goes through requireAuth, so the CSRF check for cookie sessions applies, and a missing or
// invalid credential is `null` (unauthenticated), never a default account.
import type { Env } from '../index';
import { AuthError } from './session';
import { requireAuth, type AuthContext } from '../api/auth';
import type { AccountResolver, ResolvedAccount } from '../tenancy/resolver';

/** What this resolver adds to the tenancy seam: how the caller authenticated. */
export interface AuthedAccount extends ResolvedAccount {
  kind?: AuthContext['kind'];
}

export const sessionAccountResolver: AccountResolver = async (request: Request, env: Env): Promise<AuthedAccount | null> => {
  let who: AuthContext;
  try {
    who = await requireAuth(request, env);
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) return null; // no valid credential
    throw e; // 403: valid credential, not allowed (no membership, cross-site cookie write, …)
  }
  return {
    accountId: who.accountId,
    // The instance API_KEY belongs to no user.
    userId: who.kind === 'instance' ? undefined : who.userId,
    role: who.role,
    kind: who.kind,
  };
};
