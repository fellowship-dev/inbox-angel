// DELETE /api/account — a signed-in user deletes their own account.
//
// What goes: the user, their sessions, login methods (password / OAuth links), tokens, API keys, memberships,
// invites sent to their address, their email in the audit trail, and every workspace they alone belong to
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

export async function handleAccountRoutes(
  request: Request,
  ctx: ExecutionContext,
  caller: WorkspaceCaller & { kind?: AuthContext['kind'] },
  deps: WorkspaceDeps,
): Promise<Response | null> {
  if (!isAccountRoute(new URL(request.url).pathname)) return null;
  if (request.method.toUpperCase() !== 'DELETE') return err('method not allowed', 405);
  if (!caller.user || caller.kind !== 'session') return err('account deletion needs a signed-in user (not an API key)', 403);
  const user = caller.user;

  let body: { confirm?: unknown };
  try { body = await request.json(); } catch { body = {}; }
  if (typeof body.confirm !== 'string' || body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
    return err('type your account email address to confirm', 400, 'confirm_required');
  }

  const lifecycle = workspaceLifecycle(deps.db);
  const mine = await lifecycle.listForUser(user.id);
  const soleOwned: typeof mine = [];
  const blocking: Array<{ id: string; name: string; members: number }> = [];
  for (const w of mine) {
    if (w.role !== 'owner') continue;
    const owners = (await (await deps.tenantFor(w.id)).scope.team.list()).filter(u => u.role === 'owner' && u.id !== user.id);
    if (owners.length > 0) continue; // someone else owns it too: this user just leaves
    // The self-host instance workspace cannot be deleted, and leaving it ownerless would reopen first-run setup.
    if (w.member_count > 1 || w.id === IMPLICIT_WORKSPACE_ID) blocking.push({ id: w.id, name: w.name, members: w.member_count });
    else soleOwned.push(w);
  }
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
  for (const { ws, tenant, domains } of plans) {
    const erased = await eraseWorkspace(deps, ctx, tenant, domains, { id: user.id, email: user.email });
    if (!erased.ok) return erased.response;
    pasted_tokens.push(erased.cloudflare.pasted_tokens);
  }

  // Leave a trace in the workspaces that stay (by id, not by email).
  for (const w of mine.filter(w => !soleOwned.some(s => s.id === w.id))) {
    logAudit({ db: deps.db, workspaceId: w.id }, { actor_type: 'user', actor_id: user.id, action: 'account.deleted', resource_type: 'user', resource_id: user.id }, ctx);
  }
  await lifecycleQueries(deps.db).deleteUser(user.id, user.email);
  return json({ ok: true, deleted_workspaces: soleOwned.map(w => w.name), cloudflare_pasted_tokens: pasted_tokens.reduce((a, b) => a + b, 0) });
}
