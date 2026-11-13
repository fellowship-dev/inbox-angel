// Agent (MCP) rate limits. `/mcp` and `/oauth/*` are answered by the OAuth provider before the API router,
// so the router's per-IP API_LIMITER never sees them. Agents also share cloud egress addresses (every Claude
// or ChatGPT user of an installation can arrive from the same few IPs), so `/mcp` is limited per connection
// and per workspace instead of per IP.
//
// Two layers:
// 1. Every authenticated `/mcp` request: API_LIMITER (the existing 200-per-60-seconds binding in wrangler.jsonc),
//    once under the connection's key and once under each workspace the connection holds grants in.
// 2. Tools that run a full live DNS check (about 45-60 DNS-over-HTTPS lookups per resolver, two resolvers, so
//    roughly 90-120 Worker subrequests per call): an exact D1 counter, tighter than the request limit.
import type { BoundEnv } from '../index';
import type { AccessSubject } from '../access/principal';
import { d1RateLimitStorage } from '../auth/rate-limit';
import { ToolError } from './errors';

/** The API_LIMITER binding's period (wrangler.jsonc `simple.period`). The binding does not report time left. */
export const MCP_REQUEST_WINDOW_SECONDS = 60;
/** Live DNS checks per connection and per workspace, per window. */
export const DNS_CHECK_LIMITS = { perConnection: 10, perWorkspace: 30, windowSeconds: 60 } as const;
/** Tools whose every call runs `checkDomain` against two DNS-over-HTTPS resolvers. */
export const DNS_CHECK_TOOLS = ['inspect_domain', 'get_email_report', 'query_email_metrics', 'plan_remediation', 'get_source_status'] as const;

/** Workspaces a connection holds live grants in (its own workspace first). */
function workspacesOf(subject: AccessSubject): string[] {
 return [...new Set([subject.workspaceId, ...subject.grants.map(g => g.workspaceId)].filter(Boolean))];
}

export function tooManyRequests(retryAfterSeconds: number, description: string): Response {
 return Response.json({ error: 'rate_limited', error_description: description }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' } });
}

/** Null when the request may proceed; a 429 with Retry-After when the connection or one of its workspaces is over the limit. */
export async function limitMcpRequest(env: Pick<BoundEnv, 'API_LIMITER'>, subject: AccessSubject): Promise<Response | null> {
 if (!env.API_LIMITER) return null; // local tests and installs without the binding: no request limit
 if (!(await env.API_LIMITER.limit({ key: `mcp:connection:${subject.principalId}` })).success) {
  return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `This agent connection sent too many requests. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
 }
 for (const workspaceId of workspacesOf(subject)) {
  if (!(await env.API_LIMITER.limit({ key: `mcp:workspace:${workspaceId}` })).success) {
   return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `Agents connected to this workspace sent too many requests. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
  }
 }
 return null;
}

/** Browser-facing OAuth pages (consent, connection list and revoke) keep the dashboard's per-IP budget. */
export async function limitBrowserRequest(env: Pick<BoundEnv, 'API_LIMITER'>, request: Request): Promise<Response | null> {
 if (!env.API_LIMITER) return null;
 const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
 if ((await env.API_LIMITER.limit({ key: ip })).success) return null;
 return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `Too many requests from this address. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
}

export class RateLimitedError extends ToolError {
 constructor(message: string, readonly retryAfterSeconds: number) { super('rate_limited', message); }
}

/** Spend one live DNS check for this connection and workspace, or throw a tool error saying when to retry. */
export async function spendDnsCheck(env: Pick<BoundEnv, 'DB'>, principalId: string, workspaceId: string): Promise<void> {
 const storage = d1RateLimitStorage(env.DB);
 const window = DNS_CHECK_LIMITS.windowSeconds;
 const connection = await storage.consume(`mcp-dns:connection:${principalId}`, { window, max: DNS_CHECK_LIMITS.perConnection });
 if (!connection.allowed) throw new RateLimitedError(`This agent connection ran ${DNS_CHECK_LIMITS.perConnection} live DNS checks within one minute, the limit. Try again in ${connection.retryAfter} seconds.`, connection.retryAfter!);
 const workspace = await storage.consume(`mcp-dns:workspace:${workspaceId}`, { window, max: DNS_CHECK_LIMITS.perWorkspace });
 if (!workspace.allowed) throw new RateLimitedError(`Agents in this workspace ran ${DNS_CHECK_LIMITS.perWorkspace} live DNS checks within one minute, the limit. Try again in ${workspace.retryAfter} seconds.`, workspace.retryAfter!);
}

