import { forWorkspace } from '@inbox-angel/db';
import { AuthError, type Principal } from '../auth/session';
import { authorizeResource } from './resolve';
import type { AccessAction } from './grant';
/** Legacy HTTP must not turn delegated resource access into workspace-wide authority. */
export async function authorizeHttpRequest(request: Request, db: D1Database, principal: Principal): Promise<void> {
 if (principal.kind === 'session') return;
 const subject = principal.access;
 if (!subject) throw new AuthError('explicit delegated grant required', 403);
 const url = new URL(request.url), path = url.pathname, method = request.method.toUpperCase();
 // These adapters perform their own finite resource authorization before any tenant query.
 if (path.startsWith('/api/access') || path === '/api/resources' || path.startsWith('/api/mcp')) return;
 let action: AccessAction;
 let domain: string | undefined;
 const productId = url.searchParams.get('product_id') ?? undefined;
 const match = path.match(/^\/api\/domains\/(\d+)(?:\/([a-z-]+))?(?:\/.*)?$/);
 if (match) {
  const row = await forWorkspace(db, principal.workspaceId).domains.getById(Number(match[1]));
  if (!row) throw new AuthError('resource not authorized', 403);
  domain = row.domain;
  const operation = match[2];
  if (method === 'GET') {
   if (operation === 'dns-check') action = 'diagnostics:run';
   else if (operation === 'analytics') action = 'metrics:read';
   else if (operation === 'health-report' || ['stats', 'reports', 'sources', 'explore', 'anomalies', 'export'].includes(operation ?? '')) action = 'reports:read';
   else if (!operation) action = 'resources:read';
   else throw new AuthError('route not available to delegated credentials', 403);
  } else {
   // DNS/hosting/rollout execution is separately authorized and is not a reporting capability.
   throw new AuthError('route requires a signed-in operator', 403);
  }
 } else if (path === '/api/domains' && method === 'POST') {
  let body: { domain?: unknown }; try { body = await request.clone().json(); } catch { throw new AuthError('explicit domain required', 403); }
  if (typeof body.domain !== 'string') throw new AuthError('explicit domain required', 403);
  domain = body.domain.toLowerCase().trim(); action = 'domains:manage';
 } else throw new AuthError('route requires a signed-in operator or a finite resource endpoint', 403);
 try { await authorizeResource(db, subject, action, { workspaceId: principal.workspaceId, productId, domain }); }
 catch { throw new AuthError('resource or capability not authorized', 403); }
}
