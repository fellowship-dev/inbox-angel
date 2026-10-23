// /api/workspaces — the caller's workspaces: list, create, rename, leave, delete.
//
// These act on the *user*, not on the workspace named by X-Workspace-Id: the router resolves them
// without that header, and each handler checks the caller's membership (and role) in the workspace
// in the path itself. A workspace the caller is not a member of answers 404, never 403, so ids
// cannot be probed. Only signed-in users may use them (not API keys, not the instance key).
import { IMPLICIT_WORKSPACE_ID, globalQueries, workspaceLifecycle, type MembershipRole } from '@inbox-angel/db';
import type { AuthContext } from '../api/auth';
import { logAudit } from '../audit/log';
import type { TenantContext } from '../tenancy/context';
import { revokeWorkspaceConnections, type RevokeSummary } from '../lifecycle/revoke';
import { streamWorkspaceExport } from '../lifecycle/export';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);

export const isWorkspaceRoute = (path: string) => path === '/api/workspaces' || path.startsWith('/api/workspaces/');

export const MAX_WORKSPACE_NAME = 80;

export interface WorkspaceCaller {
  kind?: AuthContext['kind'];
  user: { id: string; email: string; name: string } | null;
}

export interface WorkspaceDeps {
  db: D1Database;
  mode: 'selfhost' | 'saas';
  /** A tenant for any workspace, to clean up its domains (DNS, hosted records) before it is deleted. */
  tenantFor: (workspaceId: string) => Promise<TenantContext>;
  /** Before anything is deleted: can Cloudflare (and the hosted-records zone) be reached for every domain? A message when not. */
  preflight: (tenant: TenantContext, domains: Array<{ id: number; domain: string }>) => Promise<string | null>;
  deleteDomain: (tenant: TenantContext, domainId: string, actor: { id?: string; email?: string }, ctx?: ExecutionContext) => Promise<Response>;
}

type Actor = { id?: string; email?: string };

/** Can Cloudflare be reached for every domain? A message (to show the user) when not. Nothing is deleted yet. */
export async function preflightWorkspace(deps: WorkspaceDeps, tenant: TenantContext): Promise<{ domains: Array<{ id: number; domain: string }>; blocked: string | null }> {
  const domains = (await tenant.scope.domains.list()).map(d => ({ id: d.id, domain: d.domain }));
  return { domains, blocked: await deps.preflight(tenant, domains) };
}

/**
 * Delete a workspace and everything in it: its domains one at a time through the normal delete (DNS and hosted
 * records first; each is final), then the Cloudflare access (OAuth grants are revoked remotely; a failed revoke is
 * tombstoned and retried by the cron, never blocking the delete), then the data. People who belonged only to this
 * workspace are deleted with it. The caller has checked who may do this, and run preflightWorkspace.
 */
export async function eraseWorkspace(
  deps: WorkspaceDeps, ctx: ExecutionContext, tenant: TenantContext, domains: Array<{ id: number; domain: string }>, actor: Actor,
): Promise<{ ok: true; cloudflare: RevokeSummary } | { ok: false; response: Response }> {
  let deleted = 0;
  for (const d of domains) {
    const res = await deps.deleteDomain(tenant, String(d.id), actor, ctx);
    if (!res.ok) {
      return {
        ok: false,
        response: err(
          `could not delete domain ${d.domain}. ${deleted} of ${domains.length} domain${domains.length === 1 ? ' was' : 's were'} already deleted (with their DNS records) and cannot be restored; the workspace and its remaining data are still there. Try again once it is fixed.`,
          502, 'domain_cleanup_failed',
        ),
      };
    }
    deleted++;
  }
  const cloudflare = await revokeWorkspaceConnections(tenant);
  const members = (await tenant.scope.team.list()).map((u) => u.id);
  await workspaceLifecycle(deps.db).purge(tenant.workspaceId);
  // People who belonged only to this workspace have nowhere to sign in to any more.
  for (const uid of members) await globalQueries(deps.db).users.deleteIfOrphan(uid);
  return { ok: true, cloudflare };
}

async function readName(request: Request): Promise<string | Response> {
  let body: { name?: unknown };
  try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > MAX_WORKSPACE_NAME) return err(`name is required (max ${MAX_WORKSPACE_NAME} characters)`, 400);
  return name;
}

export async function handleWorkspaceRoutes(
  request: Request,
  ctx: ExecutionContext,
  caller: WorkspaceCaller,
  deps: WorkspaceDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!isWorkspaceRoute(path)) return null;

  if (!caller.user || caller.kind !== 'session') return err('workspaces belong to a user — sign in as one', 403);
  const user = caller.user;
  const lifecycle = workspaceLifecycle(deps.db);
  const audit = (workspaceId: string, entry: Omit<Parameters<typeof logAudit>[1], 'actor_id' | 'actor_email' | 'actor_type'>) =>
    logAudit({ db: deps.db, workspaceId }, { actor_id: user.id, actor_email: user.email, actor_type: 'user', ...entry }, ctx);

  // GET /api/workspaces — every workspace the caller belongs to, with their role and the member count.
  if (path === '/api/workspaces' && method === 'GET') {
    return json({ workspaces: await lifecycle.listForUser(user.id) });
  }

  // POST /api/workspaces { name } — create one; the caller becomes its owner.
  // Hosted: any user. Self-host: only the instance owner (owner of ws_default). A new workspace's owner can connect Cloudflare
  // accounts and add domains, and every other workspace member would otherwise be one invite away from doing so.
  if (path === '/api/workspaces' && method === 'POST') {
    if (deps.mode === 'selfhost' && (await lifecycle.roleOf(user.id, IMPLICIT_WORKSPACE_ID)) !== 'owner') {
      return err('only the owner of this instance can create workspaces', 403, 'instance_owner_required');
    }
    const name = await readName(request);
    if (name instanceof Response) return name;
    const id = `ws_${crypto.randomUUID().replace(/-/g, '')}`;
    await lifecycle.create(id, name, user.id);
    audit(id, { action: 'workspace.created', resource_type: 'workspace', resource_id: id, resource_name: name });
    return json({ id, name, role: 'owner', member_count: 1 }, 201);
  }

  const m = path.match(/^\/api\/workspaces\/([^/]+)(?:\/(leave|export|transfer-ownership))?$/);
  if (!m) return err('not found', 404);
  const id = decodeURIComponent(m[1]);
  const role: MembershipRole | null = await lifecycle.roleOf(user.id, id);
  if (!role) return err('workspace not found', 404);
  const workspace = (await lifecycle.get(id))!;

  // PATCH /api/workspaces/:id { name } — rename (owner).
  if (!m[2] && method === 'PATCH') {
    if (role !== 'owner') return err('only an owner can rename a workspace', 403);
    const name = await readName(request);
    if (name instanceof Response) return name;
    await lifecycle.rename(id, name);
    audit(id, { action: 'workspace.renamed', resource_type: 'workspace', resource_id: id, resource_name: name, before_value: { name: workspace.name }, after_value: { name } });
    return json({ ok: true, id, name });
  }

  // POST /api/workspaces/:id/leave — remove your own membership. Never your last workspace, never the last owner.
  if (m[2] === 'leave' && method === 'POST') {
    if ((await lifecycle.listForUser(user.id)).length <= 1) return err('you cannot leave your only workspace — create another first, or delete this one', 409, 'only_workspace');
    if (!(await lifecycle.leave(user.id, id))) return err('you are the only owner — make someone else an owner or delete the workspace', 409, 'last_owner');
    audit(id, { action: 'workspace.left', resource_type: 'user', resource_id: user.id, resource_name: user.email, before_value: { role } });
    return json({ ok: true });
  }

  // DELETE /api/workspaces/:id[?confirm=<name>] — owner only. With domains, the name must be confirmed.
  if (!m[2] && method === 'DELETE') {
    if (role !== 'owner') return err('only an owner can delete a workspace', 403);
    if (id === IMPLICIT_WORKSPACE_ID) return err('the default workspace cannot be deleted', 400, 'default_workspace');
    if ((await lifecycle.listForUser(user.id)).length <= 1) return err('you cannot delete your only workspace — create another first', 409, 'only_workspace');

    const tenant = await deps.tenantFor(id);
    const domains = (await tenant.scope.domains.list()).map(d => ({ id: d.id, domain: d.domain }));
    if (domains.length > 0 && url.searchParams.get('confirm') !== workspace.name) {
      return err(`this workspace has ${domains.length} domain${domains.length === 1 ? '' : 's'}; repeat the request with confirm=<workspace name> to delete it and all of its data`, 409, 'confirm_required');
    }
    // Domains are deleted one at a time, and each delete is final. So find out first whether Cloudflare can be reached
    // for all of them; refuse before deleting any if not.
    const blocked = await deps.preflight(tenant, domains);
    if (blocked) return err(`Cloudflare cannot be reached for ${blocked}; nothing was deleted. Fix that (or reconnect Cloudflare) and try again.`, 502, 'cloudflare_preflight_failed');
    const erased = await eraseWorkspace(deps, ctx, tenant, domains, { id: user.id, email: user.email });
    if (!erased.ok) return erased.response;
    // pasted_tokens: API tokens cannot be revoked from here; the owner revokes them in the Cloudflare dashboard.
    return json({ ok: true, cloudflare: erased.cloudflare });
  }

  // GET /api/workspaces/:id/export — everything the workspace holds, as JSON (owner only; subject-access requests).
  if (m[2] === 'export' && method === 'GET') {
    if (role !== 'owner') return err('only an owner can export a workspace', 403);
    audit(id, { action: 'workspace.exported', resource_type: 'workspace', resource_id: id, resource_name: workspace.name });
    return streamWorkspaceExport(deps.db, id, user.email);
  }

  // POST /api/workspaces/:id/transfer-ownership { user_id } — hand ownership to another member; the caller becomes an admin.
  if (m[2] === 'transfer-ownership' && method === 'POST') {
    if (role !== 'owner') return err('only an owner can transfer ownership', 403);
    let body: { user_id?: unknown };
    try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
    const to = typeof body.user_id === 'string' ? body.user_id : '';
    if (!to || to === user.id) return err('user_id must be another member of this workspace', 400);
    const target = await (await deps.tenantFor(id)).scope.team.getMember(to);
    if (!target) return err('that person is not a member of this workspace', 404);
    if (!(await lifecycle.transferOwnership(id, user.id, to))) return err('could not transfer ownership; reload and try again', 409);
    await globalQueries(deps.db).users.setLegacyRole(to, 'admin');
    audit(id, { action: 'workspace.ownership_transferred', resource_type: 'user', resource_id: to, resource_name: target.email, before_value: { owner: user.email }, after_value: { owner: target.email } });
    return json({ ok: true });
  }

  return err('method not allowed', 405);
}
