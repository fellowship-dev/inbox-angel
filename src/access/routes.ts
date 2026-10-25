import { requireAuth, AuthError } from '../api/auth';
import type { AuthEnv } from '../auth/config';
import { AccessService } from './service';
import { authorizedDomains } from './resolve';
import { AccessDenied } from './policy';
import type { AccessAction } from './grant';

/** Independent adapter: callers must route here before the legacy tenant router. */
export async function handleAccessRoutes(request: Request, env: AuthEnv, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname, method = request.method.toUpperCase();
 if (path !== '/api/resources' && path !== '/api/access' && !path.startsWith('/api/access/')) return null;
 try {
  const auth = await requireAuth(request, env, ctx);
  if (!auth.access || !env.DB) throw new AccessDenied();
  const service = new AccessService(env.DB, auth.access), workspaceId = auth.workspaceId;
  if (path === '/api/resources' && method === 'GET') return Response.json({ domains: await authorizedDomains(env.DB, auth.access, { workspaceId, productId: url.searchParams.get('product_id') ?? undefined }) });
  if (path === '/api/access' && method === 'GET') return Response.json(await service.list(workspaceId));
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') { try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); } }
  if (path === '/api/access/products' && method === 'POST') return Response.json(await service.createProduct(workspaceId, body.name as string), { status: 201 });
  const product = path.match(/^\/api\/access\/products\/([^/]+)$/);
  if (product && (method === 'PATCH' || method === 'DELETE')) { await service.updateProduct(workspaceId, product[1], method === 'DELETE' ? { archived: true } : { name: body.name as string }); return Response.json({ ok: true }); }
  const mapping = path.match(/^\/api\/access\/products\/([^/]+)\/domains\/(\d+)$/);
  if (mapping && (method === 'PUT' || method === 'DELETE')) { await service.mapDomain(workspaceId, mapping[1], Number(mapping[2]), method === 'DELETE'); return Response.json({ ok: true }); }
  if (path === '/api/access/principals' && method === 'POST') return Response.json(await service.createPrincipal(workspaceId, body.name as string, body.kind as 'human' | 'service'), { status: 201 });
  if (path === '/api/access/grants' && method === 'POST') return Response.json(await service.grant({ workspaceId, principalId: body.principal_id as string, productId: body.product_id as string | undefined, domain: body.domain as string | undefined, actions: body.actions as AccessAction[], expiresAt: body.expires_at as number }), { status: 201 });
  if (path === '/api/access/credentials' && method === 'POST') return Response.json(await service.issueCredential(workspaceId, body.principal_id as string, body.name as string, body.expires_at as number), { status: 201 });
  const revocation = path.match(/^\/api\/access\/(principals|credentials|grants)\/([^/]+)$/);
  if (revocation && method === 'DELETE') { await service.revoke(workspaceId, revocation[1] as 'principals' | 'credentials' | 'grants', revocation[2]); return Response.json({ ok: true }); }
  return Response.json({ error: 'not found' }, { status: 404 });
 } catch (error) {
  const status = error instanceof AuthError ? error.status : error instanceof AccessDenied ? 403 : 400;
  return Response.json({ error: error instanceof Error ? error.message : 'request failed' }, { status });
 }
}
