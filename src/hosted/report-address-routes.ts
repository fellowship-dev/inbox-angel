// /api/domains/:id/report-address — a domain's DMARC report address without hosted records (MODE=saas only; see
// src/hosted/report-address.ts). Tenant-scoped like every other route: the domain is looked up through the caller's
// workspace, so another workspace's id is a 404. Writes need an owner or admin (the router refuses members first).
//
//   GET    /api/domains/:id/report-address          status: { available: false }, or the address, its state and what to publish
//   POST   /api/domains/:id/report-address          issue (201; 200 with the current status when one exists)
//   POST   /api/domains/:id/report-address/rotate   new address; the previous one keeps working for 72 h
//   DELETE /api/domains/:id/report-address          revoke at once

import type { TenantContext } from '../tenancy/context';
import { hostedEnabled } from './config';
import { issueReportAddress, reportAddressStatus, ReportAddressError, revokeReportAddress, rotateReportAddress, type ReportAddressDeps } from './report-address';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

const ROUTE = /^\/api\/domains\/([^/]+)\/report-address(?:\/(rotate))?$/;

export async function handleReportAddressRoutes(
  request: Request,
  tenant: TenantContext,
  ctx: ExecutionContext,
  actor: { id?: string | null; email?: string | null },
  deps: ReportAddressDeps = {},
): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(ROUTE);
  if (!m) return null;
  // Self-host keeps its own reports address (rua@reports.<base>): this API does not exist there.
  if (!hostedEnabled(tenant.env)) return err('not found', 404);
  const method = request.method.toUpperCase();
  const id = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NaN;
  if (isNaN(id)) return err('invalid domain id', 400);
  // Live domains of this workspace only: never another workspace's, never a pending or lost claim, never an evicted row.
  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  try {
    if (!m[2] && method === 'GET') return json(await reportAddressStatus(tenant, domain, deps));
    if (!m[2] && method === 'POST') {
      const { created, status } = await issueReportAddress(tenant, domain, deps, actor, ctx);
      return json(status, created ? 201 : 200);
    }
    if (!m[2] && method === 'DELETE') return json(await revokeReportAddress(tenant, domain, deps, actor, ctx));
    if (m[2] === 'rotate' && method === 'POST') return json(await rotateReportAddress(tenant, domain, deps, actor, ctx));
    return err('method not allowed', 405);
  } catch (e) {
    if (e instanceof ReportAddressError) return err(e.message, e.status);
    throw e;
  }
}
