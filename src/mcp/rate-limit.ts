// Agent (MCP) rate limits. `/mcp` and `/oauth/*` are answered by the OAuth provider before the API router,
// so the router's per-IP API_LIMITER never sees them.
//
// 1. Every authenticated `/mcp` request: MCP_LIMITER (100 per 60 s) under the connection's key, then API_LIMITER
//    (200 per 60 s) under each workspace the connection holds grants in. A Workers rate-limit binding has one fixed
//    number, so the per-connection limit needs its own binding; it is half the workspace limit, so one agent at full
//    speed cannot lock the other agents of its workspace out. Agents share cloud egress addresses (every Claude or
//    ChatGPT user of an installation can arrive from the same few IPs), so authenticated requests are never limited
//    per IP. Hosted mode refuses (503) rather than run unlimited when either binding is missing.
// 2. Client registration, token requests and unauthenticated `/mcp` requests: AUTH_LIMITER (10 per 60 s) per IP.
// 3. Tools that run a full live DNS check (about 45-60 DNS-over-HTTPS lookups per resolver, two resolvers, so
//    roughly 90-120 Worker subrequests per call): an exact D1 counter, tighter than the request limit.
import { globalQueries } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import type { AccessSubject } from '../access/principal';
import { getMode } from '../tenancy/mode';
import { ToolError } from './errors';

/** The bindings' period (wrangler.jsonc `simple.period`). A binding does not report time left. */
export const MCP_REQUEST_WINDOW_SECONDS = 60;
/** wrangler.jsonc: MCP_LIMITER per connection, API_LIMITER per workspace. For docs and tests; the bindings enforce them. */
export const MCP_REQUEST_LIMITS = { perConnection: 100, perWorkspace: 200 } as const;
/** Live DNS checks per connection and per workspace, per window. */
export const DNS_CHECK_LIMITS = { perConnection: 10, perWorkspace: 30, windowSeconds: 60 } as const;
/** Tools whose every call runs `checkDomain` against two DNS-over-HTTPS resolvers. */
export const DNS_CHECK_TOOLS = ['inspect_domain', 'get_email_report', 'query_email_metrics', 'plan_remediation', 'get_source_status'] as const;
/** Share of live DNS checks that also delete expired counter rows. */
const PRUNE_RATE = 0.05;

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> };
type LimitEnv = { MODE?: string; MCP_LIMITER?: Limiter; API_LIMITER?: Limiter; AUTH_LIMITER?: Limiter };

/** Workspaces a connection holds live grants in (its own workspace first). */
function workspacesOf(subject: AccessSubject): string[] {
 return [...new Set([subject.workspaceId, ...subject.grants.map(g => g.workspaceId)].filter(Boolean))];
}

export function tooManyRequests(retryAfterSeconds: number, description: string): Response {
 return Response.json({ error: 'rate_limited', error_description: description }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' } });
}

const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';

/** Null when the request may proceed; a 429 with Retry-After when the connection or one of its workspaces is over its limit. */
export async function limitMcpRequest(env: LimitEnv, subject: AccessSubject): Promise<Response | null> {
 if (!env.MCP_LIMITER || !env.API_LIMITER) {
  // Hosted: never run unlimited. Self-host: tests and installs without the bindings keep working (the setup check says so).
  if (getMode(env) === 'saas') return Response.json({ error: 'temporarily_unavailable', error_description: 'Agent access is not available right now. The operator needs to finish this service\'s rate limits.' }, { status: 503, headers: { 'Retry-After': '300', 'Cache-Control': 'no-store' } });
  if (!env.MCP_LIMITER && !env.API_LIMITER) return null;
 }
 if (env.MCP_LIMITER && !(await env.MCP_LIMITER.limit({ key: `mcp:connection:${subject.principalId}` })).success) {
  return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `This agent connection sent too many requests. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
 }
 for (const workspaceId of env.API_LIMITER ? workspacesOf(subject) : []) {
  if (!(await env.API_LIMITER!.limit({ key: `mcp:workspace:${workspaceId}` })).success) {
   return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `Agents connected to this workspace sent too many requests. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
  }
 }
 return null;
}

/** Browser-facing OAuth pages (consent, connection list and revoke) keep the dashboard's per-IP budget. */
export async function limitBrowserRequest(env: LimitEnv, request: Request): Promise<Response | null> {
 if (!env.API_LIMITER) return null;
 if ((await env.API_LIMITER.limit({ key: clientIp(request) })).success) return null;
 return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `Too many requests from this address. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
}

/** Client registration, token requests and requests without a valid agent token: AUTH_LIMITER per IP. */
export async function limitAnonymousAgentRequest(env: LimitEnv, request: Request): Promise<Response | null> {
 if (!env.AUTH_LIMITER) return null;
 if ((await env.AUTH_LIMITER.limit({ key: `oauth:${clientIp(request)}` })).success) return null;
 return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `Too many sign-in requests from this address. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
}

export class RateLimitedError extends ToolError {
 constructor(message: string, readonly retryAfterSeconds: number) { super('rate_limited', message); }
}

/**
 * Spend one live DNS check for this connection and workspace, or throw a tool error saying when to retry.
 * Both windows are read first, so a refusal spends neither count. Two simultaneous checks can each pass the read,
 * so a window may overshoot by the number of checks in flight; the next check is then refused.
 */
export async function spendDnsCheck(env: Pick<BoundEnv, 'DB'>, principalId: string, workspaceId: string, opts: { now?: number; prune?: boolean } = {}): Promise<void> {
 const q = globalQueries(env.DB).rateLimit;
 const now = opts.now ?? Date.now(), windowMs = DNS_CHECK_LIMITS.windowSeconds * 1000;
 if (opts.prune ?? Math.random() < PRUNE_RATE) await q.prune('mcp-dns:', now - windowMs);
 const connectionKey = `mcp-dns:connection:${principalId}`, workspaceKey = `mcp-dns:workspace:${workspaceId}`;
 const [connection, workspace] = await Promise.all([q.peek(connectionKey, now, windowMs), q.peek(workspaceKey, now, windowMs)]);
 const retry = (row: { lastRequest: number }) => Math.max(1, Math.ceil((row.lastRequest + windowMs - now) / 1000));
 if (workspace && workspace.count >= DNS_CHECK_LIMITS.perWorkspace) throw new RateLimitedError(`Agents in this workspace ran ${DNS_CHECK_LIMITS.perWorkspace} live DNS checks within one minute, the limit. Try again in ${retry(workspace)} seconds.`, retry(workspace));
 if (connection && connection.count >= DNS_CHECK_LIMITS.perConnection) throw new RateLimitedError(`This agent connection ran ${DNS_CHECK_LIMITS.perConnection} live DNS checks within one minute, the limit. Try again in ${retry(connection)} seconds.`, retry(connection));
 await q.hit(connectionKey, now, windowMs);
 await q.hit(workspaceKey, now, windowMs);
}
