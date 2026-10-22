// /api/domains/:id/hosted — the domain's hosted records (MODE=saas, SAAS_ENABLED=1). Tenant-scoped like every
// other route: the domain is looked up through the caller's account, so another account's id is a 404.
//
//   GET    /api/hosted/config                    { enabled } — whether the hosted UI applies (MODE=saas and SAAS_ENABLED=1)
//   GET    /api/domains/:id/hosted               status: record names, the pointers to add, their verification, Level inputs
//   POST   /api/domains/:id/hosted               enable { spf_record?, mta_sts? } → status + intake addresses (shown once)
//   DELETE /api/domains/:id/hosted               remove the hosted records
//   POST   /api/domains/:id/hosted/rotate-token  new intake token → addresses (shown once); the old one works for 72 h
//   POST   /api/domains/:id/hosted/verify        check the customer's pointers now → status
//
// Writes need an admin (the router's member read-only rule already applies to everything but GET).

import type { TenantContext } from '../tenancy/context';
import { hostedEnabled } from './config';
import { disableHosted, enableHosted, hostedStatus, HostedError, rotateHostedToken, verifyDomainPointers, type HostedDeps } from './service';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

const ROUTE = /^\/api\/domains\/([^/]+)\/hosted(?:\/(rotate-token|verify))?$/;

export async function handleHostedRoutes(
  request: Request,
  tenant: TenantContext,
  ctx: ExecutionContext,
  actor: { id?: string | null; email?: string | null },
  deps: HostedDeps = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // GET /api/hosted/config — lets the dashboard decide whether to show the hosted UI. Never an error, never a secret.
  if (path === '/api/hosted/config' && request.method.toUpperCase() === 'GET') {
    return json({ enabled: hostedEnabled(tenant.env) });
  }
  const m = path.match(ROUTE);
  if (!m) return null;
  if (!hostedEnabled(tenant.env)) return err('not found', 404);
  const method = request.method.toUpperCase();
  const action = m[2];

  const id = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NaN;
  if (isNaN(id)) return err('invalid domain id', 400);
  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  try {
    if (!action && method === 'GET') {
      return json((await hostedStatus(tenant, domain)) ?? { enabled: false });
    }
    if (!action && method === 'POST') {
      let body: { spf_record?: unknown; mta_sts?: unknown } = {};
      try { body = request.headers.get('content-length') === '0' ? {} : await request.json(); } catch { return err('Invalid JSON body', 400); }
      if (body.spf_record !== undefined && typeof body.spf_record !== 'string') return err('spf_record must be a string', 400);
      const result = await enableHosted(tenant, domain, { spfRecord: body.spf_record as string | undefined, mtaSts: body.mta_sts === true }, deps, actor, ctx);
      return json(result, 201);
    }
    if (!action && method === 'DELETE') {
      await disableHosted(tenant, domain, deps, actor, ctx);
      return json({ ok: true });
    }
    if (action === 'rotate-token' && method === 'POST') {
      return json({ addresses: await rotateHostedToken(tenant, domain, deps, actor, ctx) });
    }
    if (action === 'verify' && method === 'POST') {
      return json(await verifyDomainPointers(tenant, domain, deps));
    }
    return err('method not allowed', 405);
  } catch (e) {
    if (e instanceof HostedError) return err(e.message, e.status);
    throw e;
  }
}
