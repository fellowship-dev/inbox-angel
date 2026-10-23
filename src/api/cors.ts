// CORS for the marketing site: the free-check endpoints, and only for the origins in SITE_ORIGINS.
// Nothing else is cross-origin callable, and cookies are never allowed on these calls (no credentials header).

import { siteOrigins, type FunnelEnv } from '../funnel/config';

const CORS_PATHS: readonly RegExp[] = [/^\/api\/check-sessions$/, /^\/api\/check-sessions\/[^/]+$/];

export const isCorsPath = (path: string): boolean => CORS_PATHS.some((re) => re.test(path));

function allowedOrigin(request: Request, env: FunnelEnv): string | null {
  const origin = request.headers.get('origin');
  return origin && siteOrigins(env).includes(origin.replace(/\/+$/, '')) ? origin : null;
}

/** Answer a preflight for a CORS path: 204 with the allow headers for an allowed origin, 403 otherwise. */
export function preflight(request: Request, env: FunnelEnv): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  const path = new URL(request.url).pathname;
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': `${path === '/api/check-sessions' ? 'POST' : 'GET'}, OPTIONS`,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

/** The response with CORS headers when the caller's origin is allowed (and Vary: Origin either way). */
export function withCors(request: Request, env: FunnelEnv, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Origin');
  const origin = allowedOrigin(request, env);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
