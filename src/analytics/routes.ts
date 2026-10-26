// HTTP adapter for the shared evidence analytics service.
import type { TenantContext } from '../tenancy/context';
import { getAnalytics, type AnalyticsDeps } from '../reports/analytics';
export { fillTrend, type AnalyticsDeps } from '../reports/analytics';

export async function handleAnalyticsRoutes(request: Request, tenant: TenantContext, deps: AnalyticsDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/(?:domains\/([^/]+)\/)?analytics$/);
  if (!match) return null;
  if (request.method.toUpperCase() !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
  const domainId = match[1] === undefined ? undefined : /^\d+$/.test(match[1]) ? Number(match[1]) : NaN;
  const n = parseInt(url.searchParams.get('days') ?? '30', 10);
  try {
    return Response.json(await getAnalytics(tenant, { ...deps, domainId, days: Number.isNaN(n) ? 30 : n }));
  } catch (e) {
    if (e instanceof Error && 'status' in e) return Response.json({ error: e.message }, { status: Number(e.status) });
    throw e;
  }
}
