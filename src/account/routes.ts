// DELETE /api/account — a signed-in user deletes their own account.
//
// What goes: the user, their sessions, login methods (password / OAuth links), tokens, API keys, memberships,
// invites sent to their address, pending invites they sent, their email in the audit trail, and every workspace they alone belong to
// (domains and DNS records, Cloudflare access revoked, all data). A workspace with other members blocks the
// deletion until its ownership is transferred (POST /api/workspaces/:id/transfer-ownership) or it is deleted.
// Typed confirmation: the body must carry the account's email address.
import { IMPLICIT_WORKSPACE_ID, lifecycleQueries, workspaceLifecycle } from '@inbox-angel/db';
import type { AuthContext } from '../api/auth';
import { logAudit } from '../audit/log';
import { eraseWorkspace, preflightWorkspace, type WorkspaceDeps } from '../workspaces/routes';
import type { WorkspaceCaller } from '../workspaces/routes';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number, code?: string, extra: Record<string, unknown> = {}) => json({ error: message, ...(code ? { code } : {}), ...extra }, status);

export const isAccountRoute = (path: string) => path === '/api/account';

/** What deleting this account would remove or leave behind; shown in the confirmation. */
async function impactOf(deps: WorkspaceDeps, user: { id: string; email: string }, mine: Awaited<ReturnType<ReturnType<typeof workspaceLifecycle>['listForUser']>>) {
  const deleted: string[] = [];
  const blocking: Array<{ id: string; name: string; members: number }> = [];
  const soleOwned: typeof mine = [];
  const connections: Array<{ workspace: string; label: string; cf_account_name: string | null }> = [];
  for (const w of mine) {
    const tenant = await deps.tenantFor(w.id);
    const staying = !(w.role === 'owner' && w.member_count <= 1);
    if (w.role === 'owner') {
      const others = (await tenant.scope.team.list()).filter(u => u.role === 'owner' && u.id !== user.id);
      if (others.length === 0) {
        // The self-host instance workspace cannot be deleted, and leaving it ownerless would reopen first-run setup.
        if (w.member_count > 1 || w.id === IMPLICIT_WORKSPACE_ID) blocking.push({ id: w.id, name: w.name, members: w.member_count });
        else { soleOwned.push(w); deleted.push(w.name); }
      }
    }
    // Connections they created in workspaces that stay keep working after they are gone: say so.
    if (staying) {
      for (const c of await tenant.scope.connections.list()) {
        if (c.created_by === user.id) connections.push({ workspace: w.name, label: c.label, cf_account_name: c.cf_account_name });
      }
    }
  }
  return { soleOwned, blocking, impact: { deleted_workspaces: deleted, connections_left_behind: connections } };
}

export async function handleAccountRoutes(
  request: Request,
  ctx: ExecutionContext,
  caller: WorkspaceCaller & { kind?: AuthContext['kind'] },
  deps: WorkspaceDeps,
): Promise<Response | null> {
  if (!isAccountRoute(new URL(request.url).pathname)) return null;
  const method = request.method.toUpperCase();
  if (method !== 'DELETE' && method !== 'GET') return err('method not allowed', 405);
  if (!caller.user || caller.kind !== 'session') return err('account deletion needs a signed-in user (not an API key)', 403);
  const user = caller.user;

  // GET /api/account — what deleting would do, for the confirmation dialog.
  if (method === 'GET') {
    const { blocking, impact } = await impactOf(deps, user, await workspaceLifecycle(deps.db).listForUser(user.id));
    return json({ email: user.email, blocking, ...impact });
  }

  let body: { confirm?: unknown };
  try { body = await request.json(); } catch { body = {}; }
  if (typeof body.confirm !== 'string' || body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
    return err('type your account email address to confirm', 400, 'confirm_required');
  }

  const mine = await workspaceLifecycle(deps.db).listForUser(user.id);
  const { soleOwned, blocking, impact } = await impactOf(deps, user, mine);
  if (blocking.length > 0) {
    return err(
      `you are the only owner of ${blocking.map(b => `"${b.name}"`).join(', ')}, which ${blocking.length === 1 ? 'has' : 'have'} other members or cannot be deleted: transfer ownership to another member first (or delete the workspace)`,
      409, 'transfer_required', { workspaces: blocking },
    );
  }

  // Cloudflare must be reachable for every domain of every workspace that goes, or nothing is deleted.
  const plans: Array<{ ws: (typeof soleOwned)[number]; tenant: Awaited<ReturnType<WorkspaceDeps['tenantFor']>>; domains: Array<{ id: number; domain: string }> }> = [];
  for (const ws of soleOwned) {
    const tenant = await deps.tenantFor(ws.id);
    const { domains, blocked } = await preflightWorkspace(deps, tenant);
    if (blocked) return err(`Cloudflare cannot be reached for ${blocked}; nothing was deleted. Fix that (or reconnect Cloudflare) and try again.`, 502, 'cloudflare_preflight_failed');
    plans.push({ ws, tenant, domains });
  }

  const pasted_tokens: number[] = [];
  const erasedNames: string[] = [];
  for (const { ws, tenant, domains } of plans) {
    const erased = await eraseWorkspace(deps, ctx, tenant, domains, { id: user.id, email: user.email });
    if (!erased.ok) {
      // Not atomic across workspaces: say which ones are already gone. The account is intact; retrying finishes the job.
      if (erasedNames.length === 0) return erased.response;
      const body = (await erased.response.json()) as { error?: string; code?: string };
      return err(`${body.error ?? 'could not delete a workspace'} Already deleted: ${erasedNames.map(n => `"${n}"`).join(', ')}. Your account was not deleted yet; try again to finish.`, erased.response.status, body.code, { already_deleted: erasedNames });
    }
    erasedNames.push(ws.name);
    pasted_tokens.push(erased.cloudflare.pasted_tokens);
  }

  // Leave a trace in the workspaces that stay (by id, not by email).
  for (const w of mine.filter(w => !soleOwned.some(s => s.id === w.id))) {
    logAudit({ db: deps.db, workspaceId: w.id }, { actor_type: 'user', actor_id: user.id, action: 'account.deleted', resource_type: 'user', resource_id: user.id }, ctx);
  }
  await lifecycleQueries(deps.db).deleteUser(user.id, user.email);
  return json({ ok: true, deleted_workspaces: soleOwned.map(w => w.name), connections_left_behind: impact.connections_left_behind.length, cloudflare_pasted_tokens: pasted_tokens.reduce((a, b) => a + b, 0) });
}
