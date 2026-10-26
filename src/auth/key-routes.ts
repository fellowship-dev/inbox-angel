// /api/keys — per-user API keys, scoped to the caller's workspace.
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import type { AuthContext } from '../api/auth';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

/** Requests members may make even though they are otherwise read-only: managing their own keys. */
export const isKeyRoute = (path: string) => path === '/api/keys' || /^\/api\/keys\/[^/]+$/.test(path);

/** The caller as the router knows it. */
export interface KeyCaller {
  role?: string;
  kind?: AuthContext['kind'];
  user: { id: string; email: string; name: string } | null;
}

export async function handleKeyRoutes(
  request: Request,
  tenant: TenantContext,
  ctx: ExecutionContext,
  auth: KeyCaller,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (!isKeyRoute(path)) return null;
  const keys = tenant.scope.apiKeys;
  const isAdmin = auth.role === 'owner' || auth.role === 'admin';

  // GET /api/keys — your keys (owners and admins: everyone's in the workspace). Prefixes only.
  if (path === '/api/keys' && method === 'GET') {
    if (!auth.user) return err('API keys belong to a user — sign in as one', 403);
    return json({ keys: await keys.list(isAdmin ? undefined : auth.user.id) });
  }

  // POST /api/keys { name, expires_in_days? } — the secret is returned once.
  if (path === '/api/keys' && method === 'POST') {
    return err('broad API keys are retired; use /api/access with explicit resources and expiry', 410);
  }

  // POST /api/keys/revoke-all — revoke all of your own keys (they survive a password change otherwise).
  if (path === '/api/keys/revoke-all' && method === 'POST') {
    if (!auth.user) return err('API keys belong to a user — sign in as one', 403);
    const n = await keys.revokeAllForUser(auth.user.id, Math.floor(Date.now() / 1000));
    logAudit(tenant, {
      actor_id: auth.user.id, actor_email: auth.user.email, actor_type: 'user',
      action: 'api_key.revoked_all', after_value: { count: n },
    }, ctx);
    return json({ ok: true, revoked: n });
  }

  // DELETE /api/keys/:id — revoke. Your own, or any in the workspace if you are an owner/admin.
  const m = path.match(/^\/api\/keys\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const existing = await keys.get(m[1]);
    if (!existing || existing.revoked_at) return err('key not found', 404);
    if (!isAdmin && existing.user_id !== auth.user?.id) return err('key not found', 404);
    await keys.revoke(m[1], Math.floor(Date.now() / 1000));
    logAudit(tenant, {
      actor_id: auth.user?.id ?? null, actor_email: auth.user?.email ?? null, actor_type: 'user',
      action: 'api_key.revoked', resource_type: 'api_key', resource_id: m[1], resource_name: existing.name,
      before_value: { prefix: existing.prefix },
    }, ctx);
    return json({ ok: true });
  }

  return err('method not allowed', 405);
}
