// Agent (MCP) rate limits. `/mcp` and `/oauth/*` are answered by the OAuth provider before the API router,
// so the router's per-IP API_LIMITER never sees them.
//
// 1. Every authenticated `/mcp` request: MCP_LIMITER (100 per 60 s) under the connection's key, then API_LIMITER
//    (200 per 60 s) under each workspace the connection holds grants in. A Workers rate-limit binding has one fixed
//    number, so the per-connection limit needs its own binding; it is half the workspace limit, so one agent at full
//    speed cannot lock the other agents of its workspace out. Agents share cloud egress addresses (every Claude or
//    ChatGPT user of an installation can arrive from the same few IPs), so authenticated requests are never limited
//    per IP. Hosted mode refuses (503) rather than run unlimited when either binding is missing.
// 2. Per IP, separate budgets: `/oauth/token` 600 (OAUTH_TOKEN_LIMITER), `/oauth/register` 10 (AUTH_LIMITER, own key),
//    `/mcp` without a token 60 (MCP_ANON_LIMITER). A presented token that fails always gets 401, never 429.
// 3. Tools that run a full live DNS check (about 45-60 DNS-over-HTTPS lookups per resolver, two resolvers, so
//    roughly 90-120 Worker subrequests per call): a D1 counter, tighter than the request limit. Each count is a
//    single conditional write, so simultaneous calls cannot pass the limit.
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
type LimitEnv = { MODE?: string; MCP_LIMITER?: Limiter; API_LIMITER?: Limiter; AUTH_LIMITER?: Limiter; OAUTH_TOKEN_LIMITER?: Limiter; MCP_ANON_LIMITER?: Limiter };

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

/**
 * Per-IP limits for requests that carry no agent identity yet. Three separate budgets, so ten registrations from an
 * address never block a token refresh from it:
 * - `/oauth/token`: OAUTH_TOKEN_LIMITER, 600 per 60 s (refreshes from assistants that share cloud addresses);
 * - `/oauth/register`: AUTH_LIMITER, 10 per 60 s, on its own key (not the sign-in key);
 * - `/mcp` with no Authorization header: MCP_ANON_LIMITER, 60 per 60 s.
 * A request that presents a token is never limited here: a bad or expired token always gets its 401, so clients refresh.
 */
export const ANONYMOUS_AGENT_LIMITS = { token: 600, register: 10, unauthenticatedMcp: 60 } as const;
export type AnonymousAgentRoute = 'token' | 'register' | 'mcp';
export async function limitAnonymousAgentRequest(env: LimitEnv, request: Request, route: AnonymousAgentRoute): Promise<Response | null> {
 const ip = clientIp(request);
 const [binding, key] = route === 'token' ? [env.OAUTH_TOKEN_LIMITER, `oauth-token:${ip}`] : route === 'register' ? [env.AUTH_LIMITER, `oauth-register:${ip}`] : [env.MCP_ANON_LIMITER, `mcp-anon:${ip}`];
 if (!binding || (await binding.limit({ key })).success) return null;
 const what = route === 'token' ? 'token requests' : route === 'register' ? 'app registrations' : 'requests without a token';
 return tooManyRequests(MCP_REQUEST_WINDOW_SECONDS, `Too many ${what} from this address. Wait ${MCP_REQUEST_WINDOW_SECONDS} seconds and try again.`);
}

export class RateLimitedError extends ToolError {
 constructor(message: string, readonly retryAfterSeconds: number) { super('rate_limited', message); }
}

/**
 * Spend one live DNS check for this connection and workspace, or throw a tool error saying when to retry.
 * Each count is one conditional write (count only while under the limit), so simultaneous calls cannot overshoot.
 * The workspace is counted first; if the connection then refuses, the workspace gets its count back. A refusal
 * therefore spends nothing that stays spent.
 */
export async function spendDnsCheck(env: Pick<BoundEnv, 'DB'>, principalId: string, workspaceId: string, opts: { now?: number; prune?: boolean } = {}): Promise<void> {
 const q = globalQueries(env.DB).rateLimit;
 const now = opts.now ?? Date.now(), windowMs = DNS_CHECK_LIMITS.windowSeconds * 1000;
 if (opts.prune ?? Math.random() < PRUNE_RATE) await q.prune('mcp-dns:', now - windowMs);
 const connectionKey = `mcp-dns:connection:${principalId}`, workspaceKey = `mcp-dns:workspace:${workspaceId}`;
 const retry = (row: { lastRequest: number } | null) => row ? Math.max(1, Math.ceil((row.lastRequest + windowMs - now) / 1000)) : DNS_CHECK_LIMITS.windowSeconds;
 const workspace = await q.hitUnder(workspaceKey, now, windowMs, DNS_CHECK_LIMITS.perWorkspace);
 if (!workspace) {
  const after = retry(await q.peek(workspaceKey, now, windowMs));
  throw new RateLimitedError(`Agents in this workspace ran ${DNS_CHECK_LIMITS.perWorkspace} live DNS checks within one minute, the limit. Try again in ${after} seconds.`, after);
 }
 const connection = await q.hitUnder(connectionKey, now, windowMs, DNS_CHECK_LIMITS.perConnection);
 if (!connection) {
  await q.giveBack(workspaceKey, workspace.lastRequest);
  const after = retry(await q.peek(connectionKey, now, windowMs));
  throw new RateLimitedError(`This agent connection ran ${DNS_CHECK_LIMITS.perConnection} live DNS checks within one minute, the limit. Try again in ${after} seconds.`, after);
 }
}
