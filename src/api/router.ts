// REST API router for InboxAngel Worker.
// All /api/* routes require authentication: the WorkspaceResolver (default: sessionWorkspaceResolver,
// src/auth/resolver.ts) turns the deprecated API_KEY, a per-user API key or a Better Auth session
// into {workspace, user, role}, and the request acts on that workspace only. Members are read-only.
//
// Unauthenticated:
//   GET  /health                              — liveness probe
//   GET  /api/version                         — running vs latest version
//   POST /api/check-sessions                  — create a free-check session (hosted: expiring check+<token>@canary address)
//   GET  /api/check-sessions/:token           — poll for free-check result
//   POST /api/monitor                         — request change alerts (unauthenticated, double opt-in: a confirmation email first)
//   GET|POST /api/unsubscribe?t=              — signed, login-free unsubscribe (src/funnel/routes.ts)
//   GET  /api/monitor/confirm?t=              — confirm a change-alert subscription
//   GET  /api/auth/status                     — owner configured? OAuth providers, mode
//   POST /api/auth/setup                      — first-run owner (self-host, closed once an owner exists)
//   POST /api/auth/signup                     — new workspace (MODE=saas)
//   POST /api/auth/login                      — password login → session token
//   POST /api/auth/logout                     — end the session
//   POST /api/auth/forgot                     — send password reset email
//   POST /api/auth/reset                      — set new password via reset token
//   *    /api/auth/{sign-in/social,callback/*,get-session,…} — Better Auth (OAuth, sessions); see src/auth/routes.ts
//   GET  /api/invites/:token                  — invite info
//   POST /api/invites/:token                  — accept invite + create user
//
// Authenticated:
//   GET    /api/domains                       — list domains
//   POST   /api/domains                       — add a domain
//   DELETE /api/domains/:id                   — remove a domain
//   GET    /api/domains/:id/stats             — daily pass/fail stats (days, max 90)
//   GET    /api/domains/:id/reports?date=     — report sources for a specific date
//   GET    /api/domains/:id/sources           — top failing sources (days, max 90)
//   GET    /api/domains/:id/explore           — all sources with pass/fail (days, max 90)
//   GET    /api/domains/:id/anomalies         — failing sources with Active/Older split
//   GET    /api/domains/:id/export            — CSV export
//   GET    /api/domains/:id/dns-check         — check _dmarc TXT record in DNS
//   *      /api/cloudflare/connections…, /api/cloudflare/oauth/…, PUT /api/domains/:id/connection — Cloudflare connections (owner/admin; src/connections/routes.ts)
//   GET/POST/DELETE /api/domains/:id/hosted, POST …/hosted/rotate-token, …/hosted/verify — hosted records (MODE=saas; src/hosted/routes.ts)
//   GET /api/analytics, GET /api/domains/:id/analytics — sender inventory, pass-rate trend, what to fix next, enforcement readiness (src/analytics/routes.ts)
//   GET    /api/domains/:id/rollout-next      — current rollout step, next step, DNS preview, safety
//   POST   /api/domains/:id/rollout-advance   — persist recommended rollout step
//   PUT    /api/domains/:id/set-default       — designate domain as default (infrastructure hub)
//   GET    /api/zones                         — list CF account zones (for zone picker)
//   GET    /api/audit-log                     — immutable audit log (admin only)
//   GET    /api/domains/:id/spf-flatten       — SPF flatten config + availability
//   POST   /api/domains/:id/spf-flatten       — enable SPF flattening (triggers initial flatten)
//   DELETE /api/domains/:id/spf-flatten       — disable + restore canonical record
//   GET    /api/domains/:id/monitor-subs      — list monitoring subscriptions
//   PATCH  /api/domains/:id/alerts            — toggle domain-level alerts on/off
//   PATCH  /api/monitor-subs/:id             — toggle subscription active status
//   GET    /api/reports                       — list recent aggregate reports
//   GET    /api/reports/:id                   — single report with per-IP records
//   GET    /api/check-results                 — recent free check results (last 20)
//   GET    /api/leads, POST /api/leads/:id/stop — free-check leads and the onboarding sequence (instance owner only)
//   GET/POST /api/keys, POST /api/keys/revoke-all, DELETE /api/keys/:id — per-user API keys
//   GET    /api/workspaces                    — the caller's workspaces (role, member count)
//   POST   /api/workspaces                    — create a workspace (caller becomes owner)
//   PATCH  /api/workspaces/:id                — rename (owner)
//   POST   /api/workspaces/:id/leave          — leave (never the last owner / only workspace)
//   DELETE /api/workspaces/:id                — delete (owner; ?confirm=<name> when it has domains); revokes Cloudflare OAuth grants
//   GET    /api/workspaces/:id/export         — JSON export of everything the workspace holds (owner)
//   POST   /api/workspaces/:id/transfer-ownership — hand ownership to another member (owner)
//   DELETE /api/account                       — delete your own account ({confirm: <your email>})
//   GET    /api/team                          — list users (admin only)
//   POST   /api/team/invite                   — send invite link (admin only; only an owner can invite an admin)
//   GET    /api/team/invites                  — pending invites (admin only)
//   DELETE /api/team/invites/:id              — revoke a pending invite (admin only)
//   POST   /api/domains/claims/:id/verify     — verify a pending domain claim (SaaS)
//   DELETE /api/domains/claims/:id            — drop a pending domain claim (SaaS)
//   DELETE /api/team/:id                      — remove team member (admin only)
//
// Self-hosted lazy init: if base domain is configured (via wizard/D1) and no domain exists yet,
// the first authenticated request auto-provisions the domain (no bootstrap call needed).

import type { BoundEnv as Env } from '../index';
import { AuthError } from './auth';
import { version } from '../../package.json';
import { globals } from '../db/scope';
import { handleAuthRoute } from '../auth/routes';
import { handleKeyRoutes, isKeyRoute } from '../auth/key-routes';
import { handleHostedRoutes } from '../hosted/routes';
import { handleAnalyticsRoutes } from '../analytics/routes';
import { handleConnectionRoutes } from '../connections/routes';
import { TokenEnvelopeError, TokenKeyError } from '../connections/crypto';
import { handleWorkspaceRoutes, isWorkspaceRoute } from '../workspaces/routes';
import { handleAccountRoutes, isAccountRoute } from '../account/routes';
import { disableHosted, HostedError, removeHostedMtaSts, updateHostedMtaSts } from '../hosted/service';
import { hostedConfig, hostedEnabled } from '../hosted/config';
import { openHostedZone } from '../hosted/records';
import { issueCanary } from '../hosted/canary';
import { isCorsPath, preflight, withCors } from './cors';
import { handleLeadRoutes, handlePublicFunnelRoute, isInstanceOwner } from '../funnel/routes';
import { requestMonitorSubscription } from '../funnel/monitor-optin';
import type { AuthedWorkspace } from '../auth/resolver';
import { IMPLICIT_WORKSPACE_ID, authLookups, globalQueries, workspaceLifecycle } from '@inbox-angel/db';
import { currentUser, passesCsrfCheck } from '../auth/session';
import { keyedHash } from '../mail/tokens';
import { getMode } from '../tenancy/mode';
import { deprovisionDomain, provisionDomain } from '../dns/provision';
import { parseDomainList, bulkInsertDomains, REPORTS_DOMAIN_MISSING } from '../domains/bulk';
import { removeAuthRecord, removeHostedRecords } from '../domains/remove';
import { admitDomain, claimView, listClaims, settleClaims, verifyClaim, type VerifiedVia } from '../domains/ownership';
import { fetchSubdomains } from '../domains/ct';
import { ensureEmailRouting, registerEmailRoutingDestination } from '../setup/email-routing';
import { track } from '../telemetry';
import { loadTenant, refreshTenant } from '../tenancy/load';
import type { TenantContext } from '../tenancy/context';
import { defaultResolver, type WorkspaceResolver } from '../tenancy/resolver';
import { CfApiError, CfAuthError, CfConnectionError, CfNotConfiguredError, CfRecordNotAllowedError, CfZoneNotAllowedError, CfZoneNotFoundError, cfErrorText } from '../tenancy/cf-client';
import { logAudit } from '../audit/log';
import { flattenSpf, restoreSpf, collectIps, buildFlatRecord } from '../email/spf-flattener';
import { buildStepRecord, parseDmarcTags, planNextStep, stepIndexForRecord, stepIndexFromStored, stepIndexFor, toStored, PASS_RATE_THRESHOLD, ROLLOUT_SEQUENCE } from '../dmarc/rollout';
import { lookupSpf, lookupDmarc, countSpfLookupsFromRecord } from '../email/dns-check';
import { createResolver, isDmarcRecord, isSpfRecord } from '@inbox-angel/dns-checks';
import { getAllDkimSelectors } from '@inbox-angel/dns-checks/email-service-providers';
import {
  provisionMtaSts,
  updateMtaStsTxtRecord,
  deprovisionMtaSts,
  discoverMxHosts,
  generatePolicyId,
  buildPolicyFile,
  patchCfDnsRecord,
} from '../email/mta-sts';

/** Free-check sessions one IP may create per window. */
export const CHECK_SESSIONS_PER_IP = 10;
const CHECK_SESSION_WINDOW_MS = 3600_000;

// ── Helpers ───────────────────────────────────────────────────

/**
 * Endpoints that act on the operator's own Cloudflare account (Email Routing, Workers custom domains) with the
 * instance token. On the hosted service they would run with a customer's connection token, widening what a
 * stolen session can do in that account, and no hosted customer needs them.
 */
const SELF_HOST_ONLY: ReadonlySet<string> = new Set([
  'POST /api/setup/email-routing',
  'POST /api/setup/custom-domain',
  'POST /api/settings/register-destination',
]);

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  // includeSubDomains is added on the hosted service only: a self-hosted dashboard may share its domain with other sites.
  'Strict-Transport-Security': 'max-age=63072000',
};

function withSecurityHeaders(response: Response, saas = false): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (saas) headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

/** HTTP status for a Cloudflare failure: config problems are the caller's, the rest is reported as given. */
function cfFailure(e: unknown, fallbackStatus = 500): Response {
  if (e instanceof CfNotConfiguredError) return json({ error: e.message, code: e.code }, 400);
  if (e instanceof CfZoneNotFoundError) return err(e.message, 400);
  if (e instanceof TokenKeyError || e instanceof TokenEnvelopeError) return err('Cloudflare connections are unavailable: the server\'s encryption key is missing or does not match the stored credentials. This is for the server operator to fix.', 503);
  // A connection that needs the owner (reconnect), or a zone the owner did not allow: not the caller's mistake to retry.
  if (e instanceof CfConnectionError) return json({ error: e.message, code: `cf_connection_${e.code}`, connection_id: e.connectionId }, 409);
  if (e instanceof CfZoneNotAllowedError) return json({ error: e.message, code: 'cf_zone_not_allowed', connection_id: e.connectionId }, 403);
  if (e instanceof CfRecordNotAllowedError) return json({ error: e.message, code: 'cf_record_not_allowed' }, 403);
  return err(cfErrorText(e), fallbackStatus);
}

async function parseBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw { status: 400, message: 'Invalid JSON body' };
  }
}

// ── Route handlers ────────────────────────────────────────────

async function getDomainsHandler(tenant: TenantContext): Promise<Response> {
  const results = await tenant.scope.domains.list();
  // `domains` are verified; `pending_claims` are domains this workspace has asked for but not yet proven (SaaS).
  return json({ domains: results, pending_claims: await listClaims(tenant) });
}

async function addDomain(request: Request, tenant: TenantContext, userEmail?: string, ctx?: ExecutionContext, actorId?: string): Promise<Response> {
  const body = await parseBody<{ domain?: string }>(request);
  if (!body.domain || typeof body.domain !== 'string') {
    return err('domain is required', 400);
  }

  const domain = body.domain.toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return err('invalid domain format', 400);
  }

  // SaaS: a domain is only a claim until its owner is proven (see src/domains/ownership.ts); nothing else happens meanwhile.
  const admission = await admitDomain(tenant, domain);
  if (admission.kind === 'taken') return err('domain already registered in another workspace', 409);
  if (admission.kind === 'limit') return err('too many unverified domains — verify or remove some first', 429);
  if (admission.kind === 'pending') {
    return json({ pending: true, claim: claimView(admission.claim), domain: null }, 202);
  }
  return createVerifiedDomain(tenant, domain, admission.via, userEmail, ctx, actorId);
}

/** Inserts a domain whose ownership is established, with the side effects of adding one. */
async function createVerifiedDomain(tenant: TenantContext, domain: string, via: VerifiedVia, userEmail?: string, ctx?: ExecutionContext, actorId?: string): Promise<Response> {
  const rdomain = tenant.settings.reportsDomain;
  if (!rdomain) return err('Reports domain not configured — complete the setup wizard first', 500);

  // Fixed rua address — routing is by XML policy_domain, not by address encoding
  const ruaAddress = `rua@${rdomain}`;

  // Compute the auth record name (but do NOT create it — wizard handles DNS provisioning)
  const authRecordName = `${domain}._report._dmarc.${rdomain}`;

  // Insert domain row — no DNS writes here; all DNS changes require explicit user action
  let domainId: number;
  try {
    const result = await tenant.scope.domains.insert({ domain, rua_address: ruaAddress, verified_via: via });
    domainId = result.meta.last_row_id as number;
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return err('domain already registered', 409);
    throw e;
  }
  await settleClaims(tenant, domain);

  track(tenant, { event: 'domain.add' }); // fire-and-forget, non-blocking

  logAudit(tenant, {
    actor_id: actorId ?? null, actor_email: userEmail ?? null, actor_type: 'user',
    action: 'domain.add',
    resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
    after_value: { domain, rua_address: ruaAddress },
  }, ctx);

  // Auto-subscribe the adding user to monitoring alerts
  const email = userEmail;
  if (email) {
    await tenant.scope.monitor.insert({
      email: email.toLowerCase().trim(),
      domain,
      session_token: null,
      confirmed_at: Math.floor(Date.now() / 1000), // a signed-in account holder adding their own domain: no confirmation needed
      spf_record: null,
      dmarc_policy: null,
      dmarc_pct: null,
      dmarc_record: null,
    }).catch(e => console.warn('[domain.add] monitor sub insert failed (non-fatal):', e));
  }

  // Background SPF lookup — fire-and-forget, doesn't block response
  if (ctx) {
    ctx.waitUntil(
      lookupSpf(domain)
        .then(spf => {
          if (spf?.lookup_count !== undefined) {
            return tenant.scope.domains.updateSpfLookupCount(domainId, spf.lookup_count);
          }
        })
        .catch(e => console.warn('[domain.add] background SPF walk failed (non-fatal):', e))
    );
  }

  // Return the full domain row so the frontend has the ID
  const domainRow = await tenant.scope.domains.getById(domainId);

  // If subdomain, fetch parent context for the inheritance-aware wizard
  let parent_context: { domain: string; dmarc_policy: string | null; dmarc_sp: string | null; has_dmarc: boolean } | null = null;
  if (domainRow?.parent_id) {
    const parentRow = await tenant.scope.domains.getById(domainRow.parent_id);
    if (parentRow) {
      // A failed lookup leaves parent_context unset: "unknown" must not be reported as "parent has no DMARC".
      const parentDmarc = await lookupDmarc(parentRow.domain).then(r => ({ ok: true as const, r }), () => ({ ok: false as const, r: null }));
      if (parentDmarc.ok) {
        const pd = parentDmarc.r;
        parent_context = {
          domain: parentRow.domain,
          dmarc_policy: pd?.policy ?? null,
          // sp= tag: null means not explicitly set (frontend distinguishes sp=none vs absent)
          dmarc_sp: pd ? (pd.subdomainPolicy ?? null) : null,
          has_dmarc: pd !== null,
        };
      }
    }
  }

  return json({
    domain: domainRow,
    rua_hint: `Add rua=mailto:${ruaAddress} to your DMARC record`,
    auth_record: authRecordName,
    dns_instructions: `Add this TXT record to authorize DMARC reports:\n  ${authRecordName}  TXT  "v=DMARC1;"`,
    ...(parent_context !== null ? { parent_context } : {}),
  }, 201);
}

/** Public handle of an invite for listing and revoking: the token itself stays with whoever was given the link. */
async function inviteId(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...digest.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The same request, minus X-Workspace-Id (for routes about the user's workspaces rather than one of them). */
function withoutWorkspaceHeader(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('x-workspace-id');
  return new Request(request.url, { method: request.method, headers });
}

/** Can Cloudflare be reached, with permission, for each domain (and the hosted zone for hosted ones)? The first problem, or null. */
async function cloudflarePreflight(tenant: TenantContext, domains: Array<{ id: number; domain: string }>): Promise<string | null> {
  for (const d of domains) {
    try {
      await tenant.zoneFor(d.domain);
    } catch (e) {
      if (e instanceof CfNotConfiguredError || e instanceof CfZoneNotFoundError) continue; // nothing of ours to clean up there
      return `${d.domain} (${e instanceof Error ? cfErrorText(e) : 'unknown error'})`;
    }
    if (hostedEnabled(tenant.env) && (await tenant.scope.hosted.get(d.id))) {
      try {
        await openHostedZone(tenant.env, hostedConfig(tenant.env).recordsZone ?? '');
      } catch (e) {
        return `${d.domain} (hosted records zone: ${e instanceof Error ? cfErrorText(e) : 'unreachable'})`;
      }
    }
  }
  return null;
}

export async function deleteDomain(tenant: TenantContext, domainId: string, actor?: { id?: string; email?: string }, ctx?: ExecutionContext): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  // Hosted records (and their quota) go first. If the DNS cleanup fails the domain is kept, so nothing is orphaned.
  try {
    await removeHostedRecords(tenant, domain, actor, ctx);
  } catch (e) {
    if (e instanceof HostedError) return err(`Could not remove the hosted records, domain not deleted: ${e.message}`, e.status);
    throw e;
  }

  await tenant.scope.domains.delete(id);

  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action: 'domain.remove',
    resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
    before_value: { domain: domain.domain, rua_address: domain.rua_address },
  }, ctx);

  await removeAuthRecord(tenant, domain, actor, ctx);

  return new Response(null, { status: 204 });
}

async function getReports(tenant: TenantContext, url: URL): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
  const results = await tenant.scope.reports.recent(limit);
  return json({ reports: results });
}

async function getReport(tenant: TenantContext, reportId: string): Promise<Response> {
  const id = parseInt(reportId, 10);
  if (isNaN(id)) return err('invalid report id', 400);

  const report = await tenant.scope.reports.getWithDomain(id);

  if (!report) return err('report not found', 404);

  const records = await tenant.scope.reports.records(id);

  return json({ report, records });
}

async function getCheckResults(tenant: TenantContext): Promise<Response> {
  // Free-check results are public-facing data written by strangers: a workspace sees only the domain-level outcome
  // for domains it has verified (the `domains` table holds verified domains only), never who ran the check.
  const domains = await tenant.scope.domains.list();
  const domainNames = domains.map(d => d.domain);

  if (domainNames.length === 0) return json({ results: [] });

  const results = await globals(tenant.db).checkResults.latestPerDomain(domainNames, 20);

  return json({ results });
}

async function getDomainStatsSummary(tenant: TenantContext, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
  const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const results = await tenant.scope.reports.dailyStats(id, since);
  return json({ domain: domain.domain, days, stats: results });
}

async function exportDomainData(tenant: TenantContext, domainId: string): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  const results = await tenant.scope.reports.exportData(id);

  const header = 'date,org_name,total_count,pass_count,fail_count,source_ip,header_from,spf_result,spf_domain,dkim_result,dkim_domain,record_count,disposition\n';
  const rows = results.map(r =>
    [r.date, r.org_name, r.total_count, r.pass_count, r.fail_count,
     r.source_ip ?? '', r.header_from ?? '', r.spf_result ?? '', r.spf_domain ?? '',
     r.dkim_result ?? '', r.dkim_domain ?? '', r.record_count ?? '', r.disposition ?? '']
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const filename = `${domain.domain}-dmarc.csv`;
  return new Response(header + rows, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

async function getDomainCheckSummary(tenant: TenantContext, domainId: string): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const summary = await tenant.scope.reports.checkSummary(id, since);
  if (!summary) return err('check summary not found', 404);

  return json(summary);
}

async function getDomainReportByDate(tenant: TenantContext, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('date param required (YYYY-MM-DD)', 400);

  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  const [summary, sources] = await Promise.all([
    tenant.scope.reports.daySummary(id, date),
    tenant.scope.reports.sourcesByDate(id, date),
  ]);

  return json({ date, domain: domain.domain, summary: summary ?? { total: 0, passed: 0, failed: 0 }, sources });
}

async function getDomainSources(tenant: TenantContext, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  const rawDays = parseInt(url.searchParams.get('days') ?? '7', 10);
  const days = Math.min(isNaN(rawDays) ? 7 : rawDays, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const results = await tenant.scope.reports.topFailingSources(id, since);
  return json({ sources: results });
}

// ── Main router ───────────────────────────────────────────────

export async function handleApi(
  request: Request,
  envRaw: Env,
  ctx: ExecutionContext,
  resolver: WorkspaceResolver = defaultResolver(envRaw),
): Promise<Response> {
  // The marketing site's free-check calls (SITE_ORIGINS only): answer preflights here, add CORS headers to the rest.
  const path = new URL(request.url).pathname;
  if (isCorsPath(path)) {
    if (request.method.toUpperCase() === 'OPTIONS') return withSecurityHeaders(preflight(request, envRaw));
    return withSecurityHeaders(withCors(request, envRaw, await _handleApi(request, envRaw, ctx, resolver)));
  }
  const res = await _handleApi(request, envRaw, ctx, resolver);
  return withSecurityHeaders(res, getMode(envRaw) === 'saas');
}

async function _handleApi(
  request: Request,
  envRaw: Env,
  ctx: ExecutionContext,
  resolver: WorkspaceResolver,
): Promise<Response> {
  const env = envRaw;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  // MODE=saas (hosted) is an explicit opt-in until it launches.
  if (getMode(env) === 'saas' && env.SAAS_ENABLED !== '1' && path !== '/health') {
    return err('MODE=saas is not enabled: set SAAS_ENABLED=1 to opt in (hosted mode is not launched yet)', 503);
  }

  // Global rate limit — 200 req/min per IP (covers all routes including unauthenticated)
  if (env.API_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    const { success } = await env.API_LIMITER.limit({ key: ip });
    if (!success) return err('too many requests', 429);
  }

  // Unauthenticated routes
  if (path === '/health' && method === 'GET') {
    return json({ ok: true, version, ts: Date.now() });
  }

  // GET /api/version — compares running version against latest GitHub release
  // Cached for 24h per-instance via CF Cache API — one GitHub request per day max
  if (path === '/api/version' && method === 'GET') {
    const GH_RAW = 'https://raw.githubusercontent.com/fellowship-dev/inbox-angel/main/package.json';
    const cacheKey = new Request(GH_RAW);
    let latest: string | null = null;
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const pkg = await cached.json() as { version: string };
        latest = pkg.version;
      } else {
        const res = await fetch(GH_RAW);
        if (res.ok) {
          const pkg = await res.json() as { version: string };
          latest = pkg.version;
          ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(pkg), {
            headers: { 'Cache-Control': 'max-age=86400', 'Content-Type': 'application/json' },
          })));
        }
      }
    } catch { /* GitHub unreachable — return current only */ }
    return json({
      current: version,
      latest,
      update_available: latest !== null && latest !== version,
      release_url: 'https://github.com/fellowship-dev/inbox-angel/releases/latest',
    });
  }

  // ── Public routes ───────────────────────────────────────────
  // No credentials, no user data. They act through an explicit anonymous context: the platform's
  // implicit workspace (where inbound check mail lands), with no user and no role.
  // A signed-in caller's own tenant if there is one, else that anonymous context.
  const tenantFor = async () => {
    let who: Awaited<ReturnType<WorkspaceResolver>> = null;
    const hasCredential = request.headers.has('x-api-key') || request.headers.has('authorization') || request.headers.has('cookie');
    if (hasCredential) {
      try { who = await resolver(request, env); } catch { /* unusable credential: treated as anonymous here */ }
    }
    return loadTenant(env, who ?? { workspaceId: IMPLICIT_WORKSPACE_ID });
  };

  // POST /api/check-sessions — generate a unique free-check email for a browser session
  // Unsubscribe and monitor confirmation links: the signed token is the credential, no login.
  const funnelResponse = await handlePublicFunnelRoute(request, env);
  if (funnelResponse) return funnelResponse;

  if (path === '/api/check-sessions' && method === 'POST') {
    // Per-IP limit on creating sessions (each is a database row and an address anyone can mail). The IP is only kept as a hash.
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
    const hit = await globalQueries(env.DB).rateLimit.hit(`check-session:${await keyedHash(env, 'ip', ip)}`, Date.now(), CHECK_SESSION_WINDOW_MS);
    if (hit.count > CHECK_SESSIONS_PER_IP) {
      return Response.json({ error: 'too many check sessions from this address, try again later' }, { status: 429, headers: { 'Retry-After': String(CHECK_SESSION_WINDOW_MS / 1000) } });
    }
    // Hosted: an expiring, single-use check+<token>@canary address that belongs to no workspace.
    if (hostedEnabled(env) && hostedConfig(env).canaryDomain) {
      const canary = await issueCanary(env);
      return json(canary, 201);
    }
    // Self-host: the same expiring, single-use check+<token>@<reports domain> address. Mail to any other local part is dropped.
    const tenant = await tenantFor();
    const rd = tenant.settings.reportsDomain;
    if (!rd) return err('Reports domain not configured — complete the setup wizard first', 500);
    const session = await issueCanary(env, undefined, rd);
    track(tenant, { event: 'check.created' }); // fire-and-forget
    return json(session, 201);
  }

  // GET /api/check-sessions/:token — poll until the check email has been processed
  const sessionMatch = path.match(/^\/api\/check-sessions\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    const result = await globals(env.DB).checkResults.byToken(sessionMatch[1]);
    if (!result) return json({ status: 'pending' }, 202);
    return json({ status: 'done', result });
  }

  // POST /api/monitor — subscribe to change alerts for a domain (unauthenticated)
  if (path === '/api/monitor' && method === 'POST') {
    const tenant = await tenantFor();
    const body = await parseBody<{ email?: string; session_token?: string }>(request);
    if (!body.email || !body.session_token) return err('email and session_token are required', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);

    const checkResult = await globals(env.DB).checkResults.byToken(body.session_token);
    if (!checkResult) return err('check result not found — send the test email first', 404);

    // Double opt-in: this stores an unconfirmed subscription and emails a confirmation link; alerts start only when it is clicked.
    const outcome = await requestMonitorSubscription(env, tenant, {
      email: body.email,
      domain: checkResult.from_domain,
      sessionToken: body.session_token,
      clientIp: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown',
      baseline: {
        spf_record: checkResult.spf_record,
        dmarc_policy: checkResult.dmarc_policy,
        dmarc_pct: null,  // not stored in check_results; will be populated on first cron run
        dmarc_record: checkResult.dmarc_record,
      },
    }, url.origin);
    return json(outcome.body, outcome.status);
  }

  // /api/auth/* and /api/invites/*: status, setup, signup, login, logout, forgot, reset, OAuth, invites
  const authResponse = await handleAuthRoute(request, env, ctx, tenantFor);
  if (authResponse) return authResponse;

  // All /api/* routes require auth
  if (!path.startsWith('/api/')) {
    return err('not found', 404);
  }

  // Who is calling, and for which workspace. The resolver is the seam between authentication and
  // tenancy: every data access, audit entry, invite and Cloudflare call below uses tenant.workspaceId.
  let workspace: Awaited<ReturnType<WorkspaceResolver>>;
  try {
    // /api/workspaces* act on the user, so a stale X-Workspace-Id (a workspace they have left) must not lock them out of listing their own.
    workspace = await resolver(isWorkspaceRoute(path) || isAccountRoute(path) ? withoutWorkspaceHeader(request) : request, env);
  } catch (e) {
    if (e instanceof AuthError && e.code === 'no_workspace' && path === '/api/workspaces' && method === 'POST') {
      // A verified login with no workspace (an invitee whose invite is gone) can make one of its own.
      const viaCookie = !request.headers.get('x-api-key') && !request.headers.get('authorization');
      if (viaCookie && !passesCsrfCheck(request, env)) return err('cross-origin request rejected', 403);
      const me = await currentUser(request, env, ctx).catch(() => null);
      if (me) {
        const deps = { db: env.DB as D1Database, mode: getMode(env), preflight: cloudflarePreflight, tenantFor: (workspaceId: string) => loadTenant(env, { workspaceId }), deleteDomain };
        const res = await handleWorkspaceRoutes(request, ctx, { kind: 'session', user: { id: me.id, email: me.email, name: me.name } }, deps);
        if (res) return res;
      }
    }
    if (e instanceof AuthError && e.code === 'no_workspace' && path === '/api/me') {
      // Signed in and verified, but in no workspace yet: offer the invitations addressed to this address.
      const me = await currentUser(request, env, ctx).catch(() => null);
      if (me) {
        const pending = await authLookups(env.DB).pendingInvitesForEmail(me.email.toLowerCase(), Math.floor(Date.now() / 1000));
        return json({ user: { id: me.id, email: me.email, name: me.name }, role: null, workspace_id: null, kind: 'session', pending_invites: pending });
      }
    }
    if (e instanceof AuthError) return err(e.message, e.status);
    return err('authentication error', 401);
  }
  if (!workspace) return err('Unauthorized — sign in, or provide an X-Api-Key header', 401);
  const tenant = await loadTenant(env, workspace);

  const actorRow = workspace.userId ? await globals(env.DB).users.byId(workspace.userId) : null;
  const userBySession = actorRow ? { id: actorRow.id, email: actorRow.email, name: actorRow.name } : null;
  const isAdmin = workspace.role === 'owner' || workspace.role === 'admin';
  if (isWorkspaceRoute(path) || isAccountRoute(path)) {
    const deps = {
      db: env.DB as D1Database,
      mode: getMode(env),
      preflight: cloudflarePreflight,
      tenantFor: (workspaceId: string) => loadTenant(env, { workspaceId }),
      deleteDomain,
    };
    const caller = { kind: (workspace as AuthedWorkspace).kind, user: userBySession };
    const res = isAccountRoute(path) ? await handleAccountRoutes(request, ctx, caller, deps) : await handleWorkspaceRoutes(request, ctx, caller, deps);
    if (res) return res;
  }
  // Members are read-only. POST /api/spf-lookup-count only computes; managing your own API keys is self-service.
  if (!(method === 'GET' || method === 'HEAD') && !isAdmin && !isKeyRoute(path) && path !== '/api/spf-lookup-count') {
    return err('admin required', 403);
  }

  if (getMode(env) === 'saas' && SELF_HOST_ONLY.has(`${method} ${path}`)) return err('not available on the hosted service', 404);

  // GET /api/me — who the caller is in this workspace (the dashboard gates controls on `role`)
  const instanceOwner = isInstanceOwner(env, { kind: (workspace as AuthedWorkspace).kind, email: userBySession?.email, role: workspace.role, workspaceId: workspace.workspaceId });
  if (path === '/api/me' && method === 'GET') {
    return json({
      instance_owner: instanceOwner,
      user: userBySession,
      role: workspace.role ?? 'member',
      workspace_id: tenant.workspaceId,
      kind: (workspace as AuthedWorkspace).kind ?? 'session',
    });
  }

  const leadResponse = await handleLeadRoutes(request, env, instanceOwner);
  if (leadResponse) return leadResponse;

  try {
    // POST /api/settings/base-domain — wizard step 0: set the base domain
    if (path === '/api/settings/base-domain' && method === 'POST') {
      const body = await parseBody<{ domain?: string }>(request);
      if (!body.domain || typeof body.domain !== 'string') return err('domain is required', 400);

      const domain = body.domain.toLowerCase().trim();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return err('invalid domain format', 400);

      // SaaS: the hub domain is a claim like any other until its owner is proven.
      const admission = await admitDomain(tenant, domain);
      if (admission.kind === 'taken') return err('this domain is already registered in another workspace', 409);
      if (admission.kind === 'limit') return err('too many unverified domains — verify or remove some first', 429);
      if (admission.kind === 'pending') return json({ ok: false, pending: true, claim: claimView(admission.claim), domain }, 202);

      // Persist base domain + derived values to D1
      const rd = `reports.${domain}`;
      const fe = `noreply@${rd}`;
      const ruaAddress = `rua@${rd}`;

      // Inbound mail is routed by reports domain and a hostname is monitored by one workspace only:
      // refuse what another workspace already owns before anything is written.
      const lifecycle = workspaceLifecycle(env.DB as D1Database);
      const hostOwner = await lifecycle.byDomain(domain);
      const reportsOwner = await lifecycle.byReportsDomain(rd);
      if ((hostOwner && hostOwner !== tenant.workspaceId) || (reportsOwner && reportsOwner !== tenant.workspaceId)) {
        return err('this domain is already registered in another workspace', 409);
      }

      // A different base domain may live in a different zone: forget the stored one so it is re-resolved.
      const forgetZone: Record<string, string> = tenant.settings.baseDomain !== domain ? { zone_id: '', zone_name: '', cf_account_id: '' } : {};
      // The domain row and the derived settings go in one batch: all of it, or none.
      let domainId: number | undefined;
      let created: number | null;
      try {
        created = await tenant.scope.baseDomain.apply({ domain, rua_address: ruaAddress, verified_via: admission.via, settings: { base_domain: domain, reports_domain: rd, from_email: fe, ...forgetZone } });
      } catch (e: any) {
        if (e?.message?.includes('UNIQUE')) return err('this domain is already registered in another workspace', 409);
        throw e;
      }
      if (created !== null) await settleClaims(tenant, domain);
      await refreshTenant(tenant);
      const zoneId = tenant.settings.zoneId;
      const cfAccountId = tenant.settings.cfAccountId;

      // The first domain configured becomes the infrastructure hub.
      if (created !== null) {
        domainId = created;
        track(tenant, { event: 'domain.add' });
        logAudit(tenant, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
          action: 'domain.add',
          resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
          after_value: { domain, rua_address: ruaAddress, source: 'wizard' },
        }, ctx);
      } else {
        domainId = (await tenant.scope.domains.list()).find(d => d.domain === domain)?.id;
      }

      // Atomically designate this domain as the default (clears any existing default first)
      if (domainId) {
        await tenant.scope.domains.setDefault(domainId);
      }

      return json({
        ok: true,
        domain,
        domain_id: domainId,
        reports_domain: rd,
        zone_id: zoneId ?? null,
        cf_account_id: cfAccountId ?? null,
      }, 201);
    }

    // GET /api/zones — list CF account zones for zone picker (requires CLOUDFLARE_API_TOKEN)
    if (path === '/api/zones' && method === 'GET') {
      // Only the instance's own workspace has the ambient token; every other workspace lists through no one's account but its own.
      const cf = tenant.cf();
      if (!cf) {
        // No ambient token: offer the zones this workspace's own active connections were allowed to manage, if any.
        const allowed = (await tenant.connections.list()).filter(c => c.status === 'active').flatMap(c => c.zones.map(z => ({ id: z.id, name: z.name, status: 'active' })));
        if (allowed.length === 0) return cfFailure(new CfNotConfiguredError());
        return json({ zones: [...new Map(allowed.map(z => [z.id, z])).values()] });
      }
      try {
        const zones = (await cf.listZones()).map(z => ({ id: z.id, name: z.name, status: z.status }));
        return json({ zones });
      } catch (e) {
        if (e instanceof CfApiError || e instanceof CfAuthError) return err(cfErrorText(e), 502);
        return err('Failed to fetch zones from Cloudflare', 502);
      }
    }

    // GET /api/domains
    if (path === '/api/domains' && method === 'GET') {
      return await getDomainsHandler(tenant);
    }
    // POST /api/domains/claims/:id/verify — the "Verify" button: re-check the proofs of a pending claim
    const claimVerifyMatch = path.match(/^\/api\/domains\/claims\/(\d+)\/verify$/);
    if (claimVerifyMatch && method === 'POST') {
      const claim = await tenant.scope.claims.getById(parseInt(claimVerifyMatch[1], 10));
      if (!claim) return err('claim not found', 404);
      const outcome = await verifyClaim(tenant, claim);
      if (outcome.kind === 'taken') return json({ error: 'another workspace has already verified this domain', code: 'domain_taken', claim: claimView({ ...claim, status: 'lost' }) }, 409);
      if (outcome.kind === 'unproven') return json({ verified: false, error: outcome.reason, claim: claimView((await tenant.scope.claims.getById(claim.id)) ?? claim) }, 422);
      return createVerifiedDomain(tenant, claim.domain, outcome.via, userBySession?.email, ctx, userBySession?.id);
    }
    // DELETE /api/domains/claims/:id — give up a pending claim
    const claimDeleteMatch = path.match(/^\/api\/domains\/claims\/(\d+)$/);
    if (claimDeleteMatch && method === 'DELETE') {
      const claim = await tenant.scope.claims.getById(parseInt(claimDeleteMatch[1], 10));
      if (!claim) return err('claim not found', 404);
      await tenant.scope.claims.delete(claim.id);
      return json({ ok: true });
    }
    // POST /api/domains
    if (path === '/api/domains' && method === 'POST') {
      const userEmail = userBySession?.email;
      return await addDomain(request, tenant, userEmail, ctx, userBySession?.id);
    }
    // GET /api/domains/:id/stats
    const domainStatsMatch = path.match(/^\/api\/domains\/([^/]+)\/stats$/);
    if (domainStatsMatch && method === 'GET') {
      return await getDomainStatsSummary(tenant, domainStatsMatch[1], url);
    }
    // GET /api/domains/:id/reports?date=YYYY-MM-DD
    const domainReportsMatch = path.match(/^\/api\/domains\/([^/]+)\/reports$/);
    if (domainReportsMatch && method === 'GET') {
      return await getDomainReportByDate(tenant, domainReportsMatch[1], url);
    }
    // GET /api/domains/:id/sources
    const domainSourcesMatch = path.match(/^\/api\/domains\/([^/]+)\/sources$/);
    if (domainSourcesMatch && method === 'GET') {
      return await getDomainSources(tenant, domainSourcesMatch[1], url);
    }
    // GET /api/domains/:id/explore?days=30
    const exploreMatch = path.match(/^\/api\/domains\/([^/]+)\/explore$/);
    if (exploreMatch && method === 'GET') {
      const id = parseInt(exploreMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);
      const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
      const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const results = await tenant.scope.reports.allSources(id, since);
      return json({ days, domain: domain.domain, sources: results });
    }
    // GET /api/domains/:id/anomalies?days=30
    const anomaliesMatch = path.match(/^\/api\/domains\/([^/]+)\/anomalies$/);
    if (anomaliesMatch && method === 'GET') {
      const id = parseInt(anomaliesMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);
      const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
      const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const results = await tenant.scope.reports.anomalySources(id, since);
      return json({ days, domain: domain.domain, anomalies: results });
    }
    // GET /api/domains/:id/export — CSV download (requires normal session/API key auth)
    const exportMatch = path.match(/^\/api\/domains\/([^/]+)\/export$/);
    if (exportMatch && method === 'GET') {
      return await exportDomainData(tenant, exportMatch[1]);
    }
    // GET /api/domains/:id/check-summary — DMARC/SPF/DKIM/MTA-STS summary for PDF report
    const checkSummaryMatch = path.match(/^\/api\/domains\/([^/]+)\/check-summary$/);
    if (checkSummaryMatch && method === 'GET') {
      return await getDomainCheckSummary(tenant, checkSummaryMatch[1]);
    }
    // GET /api/domains/:id/dns-check — check if user has added the _dmarc TXT record
    const dnsCheckMatch = path.match(/^\/api\/domains\/([^/]+)\/dns-check$/);
    if (dnsCheckMatch && method === 'GET') {
      const id = parseInt(dnsCheckMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      try {
        const txt = await createResolver().txt(`_dmarc.${domain.domain}`);
        // SERVFAIL / timeout / HTTP error / malformed answer: we don't know, so don't say "not found"
        if (txt.status === 'error') {
          return json({ found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' });
        }
        const records = txt.records;
        const found = records.length > 0;
        const has_rua = records.some(r => r.includes(domain.rua_address));
        const current_record = records[0] ?? null;
        const cf_managed = !!domain.dns_record_id;
        if (found) track(tenant, { event: 'domain.dns_verified' }); // fire-and-forget
        return json({ found, has_rua, current_record, cf_managed });
      } catch {
        return json({ found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' });
      }
    }
    // PATCH /api/domains/:id/dmarc — update DMARC policy via CF DNS (CF-managed domains only)
    const dmarcPatchMatch = path.match(/^\/api\/domains\/([^/]+)\/dmarc$/);
    if (dmarcPatchMatch && method === 'PATCH') {
      const id = parseInt(dmarcPatchMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);
      if (!domain.dns_record_id) return err('domain is not CF-managed — update DNS manually', 400);
      if (!tenant.hasCloudflare()) return cfFailure(new CfNotConfiguredError());

      const body = await parseBody<{ policy?: string }>(request);
      const policy = body.policy;
      if (!policy || !['none', 'quarantine', 'reject'].includes(policy)) {
        return err('policy must be none, quarantine, or reject', 400);
      }

      // Build updated TXT record, preserving rua= and any pct= from existing record
      const rd = tenant.settings.reportsDomain;
      const ruaPart = rd ? `; rua=mailto:${domain.rua_address}` : '';
      const newRecord = `v=DMARC1; p=${policy}${ruaPart}`;

      try {
        // The record lives in the zone of the domain being updated.
        await patchCfDnsRecord(tenant, domain.domain, domain.dns_record_id, newRecord);
      } catch (e: any) {
        return err(e.message ?? 'CF DNS patch failed', 500);
      }

      const prevPolicy = domain.dmarc_policy ?? 'none';
      await tenant.scope.domains.updateDmarcPolicy(id, policy);

      logAudit(tenant, {
          actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
        action: 'domain.dmarc_mode_change',
        resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
        before_value: { policy: prevPolicy },
        after_value: { policy, record: newRecord },
      }, ctx);
      track(tenant, { event: 'domain.dmarc_mode_change', from: prevPolicy, to: policy });

      return json({ ok: true, policy, record: newRecord });
    }

    // GET /api/domains/:id/onboarding-status — DMARC + SPF + DKIM + routing health check
    const onboardingMatch = path.match(/^\/api\/domains\/([^/]+)\/onboarding-status$/);
    if (onboardingMatch && method === 'GET') {
      const id = parseInt(onboardingMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      const rd = tenant.settings.reportsDomain;
      const DKIM_SELECTORS = getAllDkimSelectors();

      // Live DNS goes through the shared resolver: a DNS *error* is reported as such
      // (`dns_errors`), never as "record not found".
      const dnsResolver = createResolver();
      const dns_errors: string[] = [];

      const [spfLiveData, dmarcData, routingData, dkimData, nullSenderData, authRecordData] = await Promise.all([
        // SPF: TXT lookup for {domain} → find v=spf1
        dnsResolver.txt(domain.domain).then(t => {
          if (t.status === 'error') { dns_errors.push(`spf: ${t.error}`); return null; }
          return t.records.find(isSpfRecord) ?? null;
        }),

        // DMARC: TXT lookup for _dmarc.{domain}
        dnsResolver.txt(`_dmarc.${domain.domain}`).then(t => {
          if (t.status === 'error') {
            dns_errors.push(`dmarc: ${t.error}`);
            return { found: false, has_our_rua: false, current_record: null as string | null, error: t.error };
          }
          return { found: t.records.length > 0, has_our_rua: t.records.some(r => r.includes(domain.rua_address)), current_record: t.records[0] ?? null };
        }),

        // Routing: MX check + destination email verification
        (async () => {
          const mxResult = rd
            ? await dnsResolver.resolve(rd, 'MX').then(r => {
                if (r.status === 'error') { dns_errors.push(`mx: ${r.error}`); return { mx_found: false }; }
                return { mx_found: r.status === 'ok' };
              })
            : { mx_found: false };

          // Check if the admin's email is verified as a CF Email Routing destination
          let destination_verified = false;
          let destination_debug: string | undefined;
          const admin = await tenant.scope.team.firstAdmin();
          const admin_email = admin?.email ?? null;
          const cfAccountId = tenant.settings.cfAccountId;
          let cf: Awaited<ReturnType<typeof tenant.cfFor>> | null = null;
          if (tenant.hasCloudflare() && rd) {
            try { cf = await tenant.cfFor(rd); } catch (e) { destination_debug = e instanceof Error ? e.message : 'no usable Cloudflare connection'; }
          }
          if (!cf) {
            destination_debug ??= 'no CF token';
          } else if (!cfAccountId) {
            destination_debug = 'workspace ID not resolved';
          } else if (!admin?.email) {
            destination_debug = 'no admin email found';
          } else {
            try {
              const destinations = await cf.request<{ email: string; verified?: string | null }[]>('GET', `/accounts/${cfAccountId}/email/routing/addresses`);
              const match = destinations?.find(d => d.email === admin.email);
              if (!match) {
                destination_debug = `email ${admin.email} not found in routing destinations`;
              } else if (!match.verified) {
                destination_debug = 'email found but not yet verified';
              } else {
                destination_verified = true;
              }
            } catch (e) {
              destination_debug = e instanceof CfApiError || e instanceof CfAuthError
                ? `CF API error: ${cfErrorText(e)}`
                : `fetch error: ${e instanceof Error ? e.message : String(e)}`;
            }
          }

          return { ...mxResult, destination_verified, admin_email, ...(destination_debug ? { destination_debug } : {}) };
        })(),

        // DKIM: CF API if available (full zone scan), else DoH for common selectors
        // Scans both TXT and CNAME records — providers like Proton Mail use CNAMEs for DKIM
        (async () => {
          if (tenant.hasCloudflare()) {
            try {
              // DKIM records live in this domain's own zone.
              const cf = await tenant.cfFor(domain.domain);
              const zone = await cf.zoneFor(domain.domain);
              const [txtRecords, cnameRecords] = await Promise.all([
                cf.listDnsRecords(zone.id, { type: 'TXT', per_page: 100 }),
                cf.listDnsRecords(zone.id, { type: 'CNAME', per_page: 100 }),
              ]);
              const found = [...txtRecords, ...cnameRecords].filter(r => r.name.includes('_domainkey'));
              return { selectors: found.map(r => ({ name: r.name, record: r.content })), source: 'cf' as const };
            } catch { /* no usable zone or API access: fall back to DNS */ }
          }
          // DoH fallback
          const hits = await Promise.all(DKIM_SELECTORS.map(async sel => {
            const t = await dnsResolver.txt(`${sel}._domainkey.${domain.domain}`);
            if (t.status === 'error') { dns_errors.push(`dkim ${sel}: ${t.error}`); return null; }
            if (t.records.length > 0) return { name: `${sel}._domainkey.${domain.domain}`, record: t.records[0] };
            return null;
          }));
          return { selectors: hits.filter(Boolean) as { name: string; record: string }[], source: 'doh' as const };
        })(),

        // Null-sender protection: check SPF + DMARC on reports subdomain
        (async () => {
          if (!rd) return { spf: false, dmarc: false };
          const [spfRes, dmarcRes] = await Promise.all([
            dnsResolver.txt(rd).then(t => {
              if (t.status === 'error') { dns_errors.push(`null-sender spf: ${t.error}`); return false; }
              return t.records.some(isSpfRecord);
            }),
            dnsResolver.txt(`_dmarc.${rd}`).then(t => {
              if (t.status === 'error') { dns_errors.push(`null-sender dmarc: ${t.error}`); return false; }
              return t.records.some(isDmarcRecord);
            }),
          ]);
          return { spf: spfRes, dmarc: dmarcRes };
        })(),

        // Auth record: DoH check for {domain}._report._dmarc.{reportsDomain}
        (async () => {
          if (!rd) return { found: false, record_name: null };
          const authName = `${domain.domain}._report._dmarc.${rd}`;
          const t = await dnsResolver.txt(authName);
          if (t.status === 'error') {
            dns_errors.push(`auth record: ${t.error}`);
            return { found: false, record_name: authName };
          }
          return { found: t.records.some(isDmarcRecord), record_name: authName };
        })(),
      ]);

      const spfFlatConfig = await tenant.scope.spf.get(domain.id);
      return json({
        domain_id: domain.id,
        domain: domain.domain,
        rua_address: domain.rua_address,
        cf_available: tenant.hasCloudflare(),
        dmarc: { ...dmarcData, auth_record: authRecordData },
        spf: { record: spfLiveData ?? domain.spf_record ?? null, lookup_count: domain.spf_lookup_count ?? null, flattening_active: !!(spfFlatConfig?.enabled) },
        dkim: dkimData,
        routing: { ...routingData, reports_domain: rd ?? null, null_sender_spf: nullSenderData.spf, null_sender_dmarc: nullSenderData.dmarc },
        // Checks whose DNS lookup failed; their values above are "unknown", not "absent".
        ...(dns_errors.length ? { dns_errors } : {}),
      });
    }

    // POST /api/setup/email-routing — set up MX records + catch-all rule for reports domain
    if (path === '/api/setup/email-routing' && method === 'POST') {
      if (!tenant.hasCloudflare()) return cfFailure(new CfNotConfiguredError());
      const rd = tenant.settings.reportsDomain;
      if (!rd) return err('Reports domain not configured — complete the setup wizard first', 400);

      let result;
      try {
        result = await ensureEmailRouting(tenant);
      } catch (e: any) {
        return err(e.message ?? 'Email routing setup failed', 500);
      }
      if (result.status !== 'skipped') {
        logAudit(tenant, {
              actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
          action: 'setup.email_routing',
          resource_type: 'email_routing', resource_id: rd, resource_name: rd,
          meta: { routing_status: result.status },
        }, ctx);
      }

      return json({ ok: true, reports_domain: rd, status: result.status, detail: result.detail });
    }

    // POST /api/settings/register-destination — register admin email as CF Email Routing destination
    if (path === '/api/settings/register-destination' && method === 'POST') {
      if (!tenant.hasCloudflare() || !tenant.settings.cfAccountId) return cfFailure(new CfNotConfiguredError());
      const admin = await tenant.scope.team.firstAdmin();
      if (!admin?.email) return err('no admin email found', 400);
      const sent = await registerEmailRoutingDestination(tenant, admin.email);
      return json({ ok: true, email: admin.email, verification_sent: sent });
    }

    // POST /api/domains/:id/apply-dmarc — create or update _dmarc.{domain} TXT in CF DNS
    const applyDmarcMatch = path.match(/^\/api\/domains\/([^/]+)\/apply-dmarc$/);
    if (applyDmarcMatch && method === 'POST') {
      const id = parseInt(applyDmarcMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);
      if (!tenant.hasCloudflare()) return cfFailure(new CfNotConfiguredError());

      const body = await parseBody<{ record?: string }>(request);
      if (!body.record) return err('record content is required', 400);

      const recordName = `_dmarc.${domain.domain}`;

      // The write goes to the zone this domain lives in, through the connection it is linked to.
      let written;
      let existingId: string | undefined;
      try {
        const cf = await tenant.cfFor(domain.domain);
        const zone = await cf.zoneFor(domain.domain);
        existingId = (await cf.listDnsRecords(zone.id, { type: 'TXT', name: recordName, per_page: 5 }))[0]?.id;
        written = existingId
          ? await cf.patchDnsRecord(zone.id, existingId, { content: body.record })
          : await cf.createDnsRecord(zone.id, { type: 'TXT', name: recordName, content: body.record, ttl: 3600 });
      } catch (e) {
        return cfFailure(e);
      }

      logAudit(tenant, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: existingId ? 'dns.update' : 'dns.create',
        resource_type: 'dns_record', resource_id: written?.id ?? '', resource_name: recordName,
        after_value: { type: 'TXT', name: recordName, content: body.record },
      }, ctx);

      // Provision the cross-domain DMARC authorization record if not already present
      let authProvisioned = false;
      const rd = tenant.settings.reportsDomain;
      if (rd && !domain.dns_record_id) {
        try {
          const authResult = await provisionDomain(tenant, domain.domain, {
            actor_id: userBySession?.id ?? null,
            actor_email: userBySession?.email ?? null, actor_type: 'user', ctx,
          });
          if (authResult.recordId) {
            await tenant.scope.domains.setDnsRecord(id, authResult.recordId, { provisioned: true });
            authProvisioned = true;
          }
        } catch (e) {
          // Non-fatal — DMARC record itself was applied; auth record can be retried
          console.warn(`[apply-dmarc] auth record provisioning failed for ${domain.domain}:`, e);
        }
      }

      return json({ ok: true, record: body.record, created: !existingId, auth_record_provisioned: authProvisioned || !!domain.dns_record_id });
    }

    // POST /api/spf-lookup-count — count real DNS lookups for an arbitrary SPF record
    if (path === '/api/spf-lookup-count' && method === 'POST') {
      const body = await parseBody<{ record?: string }>(request);
      if (!body.record) return err('record is required', 400);
      if (!body.record.startsWith('v=spf1')) return err('SPF record must start with v=spf1', 400);
      try {
        const lookup_count = await countSpfLookupsFromRecord(body.record);
        return json({ lookup_count });
      } catch (e) {
        return err(e instanceof Error ? e.message : 'DNS lookup failed', 502);
      }
    }

    // POST /api/domains/:id/apply-spf — create or update SPF TXT record in CF DNS
    const applySpfMatch = path.match(/^\/api\/domains\/([^/]+)\/apply-spf$/);
    if (applySpfMatch && method === 'POST') {
      const id = parseInt(applySpfMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);
      if (!tenant.hasCloudflare()) return cfFailure(new CfNotConfiguredError());

      // Block if SPF flattening is active — wizard edits would be overwritten by next cron run
      const flatConfig = await tenant.scope.spf.get(id);
      if (flatConfig?.enabled) return err('SPF flattening is active for this domain. Disable it before editing the SPF record manually.', 409);

      const body = await parseBody<{ record?: string; confirm_overwrite?: boolean }>(request);
      if (!body.record) return err('record content is required', 400);
      if (!body.record.startsWith('v=spf1')) return err('SPF record must start with v=spf1', 400);
      if (!body.record.includes('all')) return err('SPF record must end with an all mechanism', 400);

      const recordName = domain.domain;

      // Find the existing SPF TXT record in this domain's own zone
      let cf: Awaited<ReturnType<typeof tenant.cfFor>>;
      let zoneId: string;
      let existingSpf;
      try {
        cf = await tenant.cfFor(domain.domain);
        zoneId = (await cf.zoneFor(domain.domain)).id;
        existingSpf = (await cf.listDnsRecords(zoneId, { type: 'TXT', name: recordName, per_page: 100 }))
          .find(r => r.content.replace(/^"|"$/g, '').startsWith('v=spf1'));
      } catch (e) {
        return cfFailure(e);
      }
      const existingId = existingSpf?.id;

      // Safety: require explicit confirmation when overwriting an existing record
      if (existingSpf && !body.confirm_overwrite) {
        return json({ ok: false, needs_confirmation: true, existing_record: existingSpf.content.replace(/^"|"$/g, ''), proposed_record: body.record }, 200);
      }

      let written;
      try {
        written = existingId
          ? await cf.patchDnsRecord(zoneId, existingId, { content: body.record }, { allowedApexes: [recordName] })
          : await cf.createDnsRecord(zoneId, { type: 'TXT', name: recordName, content: body.record, ttl: 3600 }, { allowedApexes: [recordName] });
      } catch (e) {
        return cfFailure(e);
      }

      logAudit(tenant, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: existingId ? 'dns.update' : 'dns.create',
        resource_type: 'dns_record', resource_id: written?.id ?? '', resource_name: recordName,
        before_value: existingSpf ? { type: 'TXT', name: recordName, content: existingSpf.content } : null,
        after_value: { type: 'TXT', name: recordName, content: body.record },
      }, ctx);

      return json({ ok: true, record: body.record, created: !existingId });
    }

    // POST /api/setup/custom-domain — register inbox-angel.{BASE_DOMAIN} as CF Custom Domain
    if (path === '/api/setup/custom-domain' && method === 'POST') {
      if (!tenant.hasCloudflare()) return cfFailure(new CfNotConfiguredError());
      const bd = tenant.settings.baseDomain;
      if (!bd) return err('Base domain not configured', 400);

      const workerName = tenant.workerName;
      const hostname = `inbox-angel.${bd}`;

      // The hostname is on the base domain's zone.
      let cf: Awaited<ReturnType<typeof tenant.cfFor>>;
      let zone;
      try {
        cf = await tenant.cfFor(bd);
        zone = await cf.zoneFor(bd);
      } catch (e) {
        return cfFailure(e, 502);
      }
      const cfAccountId = zone.cfAccountId ?? tenant.settings.cfAccountId;
      if (!cfAccountId) return err('Account ID not available', 400);

      try {
        await cf.request('PUT', `/accounts/${cfAccountId}/workers/domains`, {
          body: { environment: 'production', hostname, service: workerName, zone_id: zone.id },
        });
      } catch (e) {
        return err(cfErrorText(e) || 'Failed to register custom domain', 502);
      }

      await tenant.scope.settings.set('custom_domain', hostname);
      logAudit(tenant, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: 'setup.custom_domain',
        resource_type: 'custom_domain', resource_id: hostname, resource_name: hostname,
      }, ctx);

      return json({ ok: true, hostname });
    }

    // GET /api/domains/:id/wizard-state — per-step completion state for onboarding wizard
    const wizardGetMatch = path.match(/^\/api\/domains\/([^/]+)\/wizard-state$/);
    if (wizardGetMatch && method === 'GET') {
      const id = parseInt(wizardGetMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      const raw = await tenant.scope.settings.get(`wizard_state_${id}`);
      const defaults = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' };
      const state = raw ? { ...defaults, ...JSON.parse(raw.value) } : defaults;
      return json(state);
    }

    // PUT /api/domains/:id/wizard-state — update step completion states
    const wizardPutMatch = path.match(/^\/api\/domains\/([^/]+)\/wizard-state$/);
    if (wizardPutMatch && method === 'PUT') {
      const id = parseInt(wizardPutMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      const body = await parseBody<Record<string, string>>(request);
      const validSteps = ['domain', 'spf', 'dkim', 'dmarc', 'routing'];
      const validStates = ['not_started', 'complete', 'skipped'];

      // Merge with existing state
      const raw = await tenant.scope.settings.get(`wizard_state_${id}`);
      const defaults = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' };
      const current = raw ? { ...defaults, ...JSON.parse(raw.value) } : defaults;

      for (const [step, state] of Object.entries(body)) {
        if (validSteps.includes(step) && validStates.includes(state)) {
          current[step] = state;
        }
      }

      await tenant.scope.settings.set(`wizard_state_${id}`, JSON.stringify(current));
      return json(current);
    }

    // PUT /api/domains/:id/set-default — designate this domain as the default (infrastructure hub).
    // Atomically clears is_default on all rows then sets it on the target.
    // Resets env caches so REPORTS_DOMAIN/FROM_EMAIL re-derive immediately.
    // Does NOT re-provision DNS — caller must re-apply DMARC on other domains if needed.
    const setDefaultMatch = path.match(/^\/api\/domains\/([^/]+)\/set-default$/);
    if (setDefaultMatch && method === 'PUT') {
      const id = parseInt(setDefaultMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      await tenant.scope.domains.setDefault(id);

      logAudit(tenant, {
        actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: 'domain.set_default',
        resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
        after_value: { is_default: true },
      }, ctx);

      return json({
        ok: true,
        domain: domain.domain,
        warning: 'Auth records for other domains now point to the old reports subdomain. Re-apply DMARC on each domain to update them.',
      });
    }

    // GET /api/domains/:id/rollout-next — current rollout step, next step, DNS preview, safety checks
    const rolloutNextMatch = path.match(/^\/api\/domains\/([^/]+)\/rollout-next$/);
    if (rolloutNextMatch && method === 'GET') {
      const id = parseInt(rolloutNextMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      // Fetch live DMARC record to get current p= / t= (and legacy pct=)
      let currentRecord: string | null = null;
      let livePct: number | null = null;
      let livePolicy: string | null = null;
      let liveTesting = false;
      try {
        const txt = await createResolver().txt(`_dmarc.${domain.domain}`);
        if (txt.status === 'error') throw new Error(txt.error); // unknown, not "no record": fall through without live data
        currentRecord = txt.records.find(isDmarcRecord) ?? null;
        if (currentRecord) {
          const tags = parseDmarcTags(currentRecord);
          livePolicy = tags.get('p')?.toLowerCase() ?? null;
          livePct = tags.has('pct') ? parseInt(tags.get('pct')!, 10) : 100; // legacy; RFC 9989 removed pct
          liveTesting = tags.get('t')?.toLowerCase() === 'y';
        }
      } catch {
        // DNS unavailable — proceed without live data
      }

      // Pass rate from last 30 days
      const since30d = Math.floor(Date.now() / 1000) - 30 * 86400;
      const statsResult = await tenant.scope.reports.dailyStats(id, since30d);
      const rows = statsResult ?? [];
      const totalMsgs = rows.reduce((n, r) => n + (r.total ?? 0), 0);
      const passedMsgs = rows.reduce((n, r) => n + (r.passed ?? 0), 0);
      const passRate = totalMsgs > 0 ? Math.round((passedMsgs / totalMsgs) * 100) : null;

      // Unknown senders check: sources with no aligned domain in last 7 days
      const since7d = Math.floor(Date.now() / 1000) - 7 * 86400;
      const sourcesResult = await tenant.scope.reports.topFailingSources(id, since7d);
      const unknownSenders = (sourcesResult ?? []).filter(
        (s: any) => !s.spf_domain && !s.dkim_domain
      ).length;

      const currentStepIndex = currentRecord ? stepIndexForRecord(currentRecord) : 0;
      const plan = currentStepIndex === -1 ? null : planNextStep(currentRecord);
      const nextStep = plan?.step ?? null;

      // Safety: block if pass rate is below threshold
      const blocked = passRate !== null && passRate < PASS_RATE_THRESHOLD;
      const blockReason = blocked
        ? `Pass rate is ${passRate}% — must be ≥${PASS_RATE_THRESHOLD}% to advance`
        : null;

      // Safety: warn if unknown senders present
      const hasUnknownSenders = unknownSenders > 0;

      const dnsPreview = nextStep && currentRecord
        ? buildStepRecord(currentRecord, nextStep)
        : null;

      // Behind schedule: recommended step is ahead of live step
      const recStepIndex = stepIndexFromStored(domain.rollout_rec_policy, domain.rollout_rec_pct);
      const behindSchedule = recStepIndex > currentStepIndex;

      return json({
        current_policy: livePolicy,
        current_pct: livePct,
        current_testing: liveTesting,
        current_record: currentRecord,
        current_step_index: currentStepIndex,
        total_steps: ROLLOUT_SEQUENCE.length,
        next_step: nextStep,
        next_step_note: plan?.note ?? null,
        dns_preview: dnsPreview,
        pass_rate: passRate,
        blocked,
        block_reason: blockReason,
        has_unknown_senders: hasUnknownSenders,
        behind_schedule: behindSchedule,
        recommended_policy: domain.rollout_rec_policy,
        recommended_pct: domain.rollout_rec_pct,
      });
    }

    // POST /api/domains/:id/rollout-advance — persist recommended rollout step to DB
    const rolloutAdvanceMatch = path.match(/^\/api\/domains\/([^/]+)\/rollout-advance$/);
    if (rolloutAdvanceMatch && method === 'POST') {
      const id = parseInt(rolloutAdvanceMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      // New clients send { policy, testing }. Legacy clients send { policy, pct }: pct is
      // migrated onto the new sequence and never weakens the policy (see stepIndexFor).
      const body = await parseBody<{ policy: string; testing?: boolean; pct?: number }>(request);
      const { policy, testing, pct } = body;
      if (!policy || !['quarantine', 'reject'].includes(policy)) {
        return err('policy must be quarantine or reject', 400);
      }
      if (pct !== undefined && (typeof pct !== 'number' || ![10, 50, 100].includes(pct))) {
        return err('pct must be 10, 50, or 100', 400);
      }
      if (testing !== undefined && typeof testing !== 'boolean') {
        return err('testing must be a boolean', 400);
      }

      const stored = toStored(ROLLOUT_SEQUENCE[stepIndexFor(policy, pct ?? null, testing === true)]);
      await tenant.scope.domains.updateRollout(id, stored.policy, stored.pct);
      return json({ ok: true, rollout_rec_policy: stored.policy, rollout_rec_pct: stored.pct, rollout_rec_testing: stored.pct === 0 });
    }

    // DELETE /api/domains/:id
    const domainDeleteMatch = path.match(/^\/api\/domains\/([^/]+)$/);
    if (domainDeleteMatch && method === 'DELETE') {
      return await deleteDomain(tenant, domainDeleteMatch[1], { id: userBySession?.id, email: userBySession?.email }, ctx);
    }
    // GET /api/reports
    if (path === '/api/reports' && method === 'GET') {
      return await getReports(tenant, url);
    }
    // GET /api/reports/:id
    const reportMatch = path.match(/^\/api\/reports\/([^/]+)$/);
    if (reportMatch && method === 'GET') {
      return await getReport(tenant, reportMatch[1]);
    }
    // GET /api/check-results
    if (path === '/api/check-results' && method === 'GET') {
      return await getCheckResults(tenant);
    }

    // GET /api/domains/:id/monitor-subs — list monitoring subscriptions for a domain
    const monitorSubsMatch = path.match(/^\/api\/domains\/(\d+)\/monitor-subs$/);
    if (monitorSubsMatch && method === 'GET') {
      const domain = await tenant.scope.domains.getById(parseInt(monitorSubsMatch[1], 10));
      if (!domain) return err('domain not found', 404);
      const results = await tenant.scope.monitor.byDomain(domain.domain);
      return json({ subs: results });
    }

    // PATCH /api/monitor-subs/:id — toggle active status
    const monitorSubPatchMatch = path.match(/^\/api\/monitor-subs\/(\d+)$/);
    if (monitorSubPatchMatch && method === 'PATCH') {
      const body = await parseBody<{ active?: boolean }>(request);
      if (typeof body.active !== 'boolean') return err('active (boolean) is required', 400);
      const upd = await tenant.scope.monitor.setActive(parseInt(monitorSubPatchMatch[1], 10), body.active);
      if (!upd.meta.changes) return err('subscription not found', 404);
      return json({ ok: true });
    }

    // PATCH /api/domains/:id/alerts — toggle domain-level alerts on/off
    const domainAlertsMatch = path.match(/^\/api\/domains\/([^/]+)\/alerts$/);
    if (domainAlertsMatch && method === 'PATCH') {
      const body = await parseBody<{ alerts_enabled?: boolean }>(request);
      if (typeof body.alerts_enabled !== 'boolean') return err('alerts_enabled (boolean) is required', 400);
      const upd = await tenant.scope.domains.setAlertsEnabled(parseInt(domainAlertsMatch[1], 10), body.alerts_enabled);
      if (!upd.meta.changes) return err('domain not found', 404);
      return json({ ok: true });
    }

    // GET /api/team — list all users (admin only)
    if (path === '/api/team' && method === 'GET') {
      if (!isAdmin) return err('admin required', 403);
      const results = await tenant.scope.team.list();
      return json({ users: results, current_user_id: userBySession?.id ?? null });
    }

    // POST /api/team/invite — generate one-time invite link (admin only)
    if (path === '/api/team/invite' && method === 'POST') {
      if (!isAdmin) return err('admin required', 403);
      const actor = userBySession;
      if (!actor) return err('sign in as a user to invite teammates', 403);
      const body = await parseBody<{ email?: string; role?: string }>(request);
      if (!body.email) return err('email is required', 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);
      // Someone who already has a login is invited too: accepting adds a membership, never a second user.
      const existing = await globals(env.DB).users.byEmail(body.email.toLowerCase().trim());
      if (existing && (await tenant.scope.team.roleOf(existing.id))) return err('this person is already a member of the workspace', 409);

      const token = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days
      const inviteEmail = body.email.toLowerCase().trim();
      // Only an owner can hand out admin; owner itself cannot be granted by invite.
      if ((body.role === 'admin' || body.role === 'owner') && workspace.role !== 'owner') return err('only an owner can invite an admin or an owner', 403);
      if (body.role === 'owner') return err('ownership cannot be granted by invite', 400);
      const inviteRole = body.role === 'admin' ? 'admin' : 'member';
      await tenant.scope.team.insertInvite({
        token,
        email: inviteEmail,
        role: inviteRole,
        invited_by: actor.email,
        expires_at: expiresAt,
      });
      logAudit(tenant, {
          actor_id: actor.id, actor_email: actor.email, actor_type: 'user',
        action: 'auth.invite_sent',
        resource_type: 'user', resource_name: inviteEmail,
        after_value: { email: inviteEmail, role: inviteRole, invited_by: actor.email },
      }, ctx);
      return json({ token }, 201);
    }

    // GET /api/team/invites — pending invites (owner and admin). The token itself is not listed: `id` identifies one for revoking.
    if (path === '/api/team/invites' && method === 'GET') {
      if (!isAdmin) return err('admin required', 403);
      const pending = await tenant.scope.team.listPendingInvites();
      return json({ invites: await Promise.all(pending.map(async i => ({
        id: await inviteId(i.token), email: i.email, role: i.role, invited_by: i.invited_by, created_at: i.created_at, expires_at: i.expires_at,
      }))) });
    }
    // DELETE /api/team/invites/:id — revoke a pending invite (owner and admin)
    const inviteRevokeMatch = path.match(/^\/api\/team\/invites\/([^/]+)$/);
    if (inviteRevokeMatch && method === 'DELETE') {
      if (!isAdmin) return err('admin required', 403);
      const pending = await tenant.scope.team.listPendingInvites();
      let target: (typeof pending)[number] | undefined;
      for (const i of pending) if ((await inviteId(i.token)) === inviteRevokeMatch[1]) target = i;
      if (!target || !(await tenant.scope.team.revokeInvite(target.token))) return err('invite not found', 404);
      logAudit(tenant, {
        actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: 'auth.invite_revoked',
        resource_type: 'user', resource_name: target.email,
        before_value: { email: target.email, role: target.role, invited_by: target.invited_by },
      }, ctx);
      return json({ ok: true });
    }

    // DELETE /api/team/:id — remove a team member (admin only, can't remove self)
    const teamMemberMatch = path.match(/^\/api\/team\/([^/]+)$/);
    if (teamMemberMatch && method === 'DELETE') {
      if (!isAdmin) return err('admin required', 403);
      const actor = userBySession;
      if (!actor) return err('sign in as a user to remove teammates', 403);
      if (actor.id === teamMemberMatch[1]) return err('cannot remove yourself', 400);
      const removed = await tenant.scope.team.getMember(teamMemberMatch[1]).catch(() => null);
      if (!removed) return err('team member not found', 404);
      if (removed?.role === 'owner') return err('the owner cannot be removed', 403);
      if (removed?.role === 'admin' && workspace.role !== 'owner') return err('only the owner can remove an admin', 403);
      await tenant.scope.team.removeUser(teamMemberMatch[1]);
      // Invites they sent stop working with them.
      await tenant.scope.team.revokeInvitesBy(removed.email);
      logAudit(tenant, {
          actor_id: actor.id, actor_email: actor.email, actor_type: 'user',
        action: 'team.member_removed',
        resource_type: 'user', resource_id: teamMemberMatch[1], resource_name: removed?.email ?? teamMemberMatch[1],
        before_value: removed ? { email: removed.email, name: removed.name, role: removed.role } : null,
      }, ctx);
      return json({ ok: true });
    }

    // SPF flatten preview — resolve IPs without writing to DNS
    const spfPreviewMatch = path.match(/^\/api\/domains\/([^/]+)\/spf-flatten\/preview$/);
    if (spfPreviewMatch && method === 'GET') {
      const id = parseInt(spfPreviewMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);
      try {
        const { ips, extra, allQualifier } = await collectIps(domain.domain);
        const flattened_record = buildFlatRecord(ips, extra, allQualifier);
        return json({ flattened_record, ip_count: ips.length });
      } catch (e: any) {
        return err(e.message ?? 'Failed to resolve SPF', 500);
      }
    }

    // SPF flatten routes — GET/POST/DELETE /api/domains/:id/spf-flatten
    const spfFlattenMatch = path.match(/^\/api\/domains\/([^/]+)\/spf-flatten$/);
    if (spfFlattenMatch) {
      const id = parseInt(spfFlattenMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      const available = tenant.hasCloudflare();

      // GET — return current config + availability
      if (method === 'GET') {
        const config = await tenant.scope.spf.get(id);
        return json({ available, config: config ?? null, lookup_count: domain.spf_lookup_count ?? null });
      }

      // POST — enable + trigger initial flatten
      if (method === 'POST') {
        if (!available) return err('Cloudflare credentials not configured — complete the setup wizard first', 422);

        // Walk lookup count first (for display)
        let spfRecord;
        try {
          spfRecord = await lookupSpf(domain.domain);
        } catch (e) {
          return err(`DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`, 502);
        }
        const lookup_count = spfRecord?.lookup_count ?? null;

        // Do initial flatten
        let result;
        try {
          result = await flattenSpf(tenant, domain.domain);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Save config with error so user can see it
          await tenant.scope.spf.upsert({
            domain_id: id,
            canonical_record: spfRecord?.raw ?? '',
            lookup_count,
            cf_record_id: null,
          });
          await tenant.scope.spf.updateError(id, msg);
          return err(msg, 422);
        }

        await tenant.scope.spf.upsert({
          domain_id: id,
          canonical_record: result.canonical_record,
          lookup_count,
          cf_record_id: result.cf_record_id,
        });
        await tenant.scope.spf.updateResult(id, result.flattened_record, result.ip_count, result.cf_record_id);

        logAudit(tenant, {
              actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'spf_flatten.enable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { spf_record: result.canonical_record },
          after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
        }, ctx);
        if (result.cf_record_id) {
          logAudit(tenant, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'dns.update',
            resource_type: 'dns_record', resource_id: result.cf_record_id, resource_name: `TXT _spf.${domain.domain}`,
            before_value: { content: result.canonical_record },
            after_value: { content: result.flattened_record },
          }, ctx);
        }

        track(tenant, { event: 'spf_flatten.enable' }); // fire-and-forget
        const config = await tenant.scope.spf.get(id);
        return json({ ok: true, config }, 201);
      }

      // DELETE — disable + restore canonical record
      if (method === 'DELETE') {
        const config = await tenant.scope.spf.get(id);
        if (!config) return err('SPF flattening not configured for this domain', 404);

        if (available && config.cf_record_id && config.canonical_record) {
          try {
            await restoreSpf(tenant, domain.domain, config.cf_record_id, config.canonical_record);
          } catch (e) {
            console.warn(`[spf-flatten] restore failed for ${domain.domain}:`, e);
            // Non-fatal — delete config anyway so user can retry
          }
        }

        logAudit(tenant, {
              actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'spf_flatten.disable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { spf_record: config.flattened_record ?? config.canonical_record },
          after_value: { spf_record: config.canonical_record },
        }, ctx);
        track(tenant, { event: 'spf_flatten.disable' }); // fire-and-forget
        await tenant.scope.spf.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    // MTA-STS routes — GET/POST/PATCH/DELETE /api/domains/:id/mta-sts
    const mtaStsMatch = path.match(/^\/api\/domains\/([^/]+)\/mta-sts$/);
    if (mtaStsMatch) {
      const id = parseInt(mtaStsMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await tenant.scope.domains.getById(id);
      if (!domain) return err('domain not found', 404);

      // Hosted domains keep their MTA-STS records in the hosted zone: these methods go through the hosted writer.
      const isHosted = hostedEnabled(env) && !!(await tenant.scope.hosted.get(id));
      if (isHosted && method !== 'GET') {
        try {
          if (method === 'POST') return err('MTA-STS is hosted for this domain: enable it with POST /api/domains/:id/hosted { mta_sts: true }', 409);
          if (method === 'DELETE') {
            await removeHostedMtaSts(tenant, domain);
            logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'mta_sts.disable', resource_type: 'domain', resource_id: String(id), resource_name: domain.domain }, ctx);
            return new Response(null, { status: 204 });
          }
          if (method === 'PATCH') {
            const config = await tenant.scope.mtaSts.get(id);
            if (!config?.enabled) return err('MTA-STS not enabled for this domain', 404);
            const body = await parseBody<{ mode?: string; refresh_mx?: boolean }>(request);
            if (body.mode === 'testing' || body.mode === 'enforce') {
              const r = await updateHostedMtaSts(tenant, domain, { mode: body.mode });
              return json({ ok: true, mode: body.mode, policy_id: r.policy_id });
            }
            if (body.refresh_mx) {
              let mxHosts: string[];
              try { mxHosts = await discoverMxHosts(domain.domain); } catch (e) { return err(`DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`, 502); }
              if (mxHosts.length === 0) return err('No MX records found', 400);
              const r = await updateHostedMtaSts(tenant, domain, { mxHosts });
              return json({ ok: true, mx_hosts: mxHosts, policy_id: r.policy_id });
            }
            return err('nothing to update', 400);
          }
        } catch (e) {
          if (e instanceof HostedError) return err(e.message, e.status);
          throw e;
        }
      }

      if (method === 'GET') {
        const config = await tenant.scope.mtaSts.get(id);
        const tlsSince = Math.floor(Date.now() / 1000) - 30 * 86400; // last 30 days
        const summary = config ? await tenant.scope.reports.tlsSummary(id, tlsSince) : null;
        return json({ available: tenant.hasCloudflare(), config, summary });
      }

      if (method === 'POST') {
        // Enable MTA-STS
        if (!tenant.hasCloudflare() || !tenant.settings.reportsDomain) {
          return cfFailure(new CfNotConfiguredError());
        }
        const existing = await tenant.scope.mtaSts.get(id);
        if (existing?.enabled) return err('MTA-STS already enabled for this domain', 409);

        try {
          const result = await provisionMtaSts(tenant, domain.domain);
          await tenant.scope.mtaSts.insert({
            domain_id: id,
            mode: result.mode,
            mx_hosts: result.mx_hosts.join(','),
            policy_id: result.policy_id,
            mta_sts_record_id: result.mta_sts_record_id,
            tls_rpt_record_id: result.tls_rpt_record_id,
            cname_record_id: result.cname_record_id,
          });
          const rd = tenant.settings.reportsDomain!;
          logAudit(tenant, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.enable',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            after_value: { mode: result.mode, mx_hosts: result.mx_hosts, policy_id: result.policy_id },
          }, ctx);
          // Log each DNS record created
          logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, after_value: { type: 'TXT', name: `_mta-sts.${domain.domain}`, content: `v=STSv1; id=${result.policy_id}` } }, ctx);
          logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.tls_rpt_record_id, resource_name: `_smtp._tls.${domain.domain}`, after_value: { type: 'TXT', name: `_smtp._tls.${domain.domain}`, content: `v=TLSRPTv1; rua=mailto:tls-rpt@${rd}` } }, ctx);
          logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.cname_record_id, resource_name: `mta-sts.${domain.domain}`, after_value: { type: 'CNAME', name: `mta-sts.${domain.domain}`, proxied: true } }, ctx);
          track(tenant, { event: 'mta_sts.enable' }); // fire-and-forget
          return json({ ok: true, mode: result.mode, mx_hosts: result.mx_hosts });
        } catch (e: any) {
          return err(e.message ?? 'provisioning failed', 500);
        }
      }

      if (method === 'PATCH') {
        // Update mode (testing → enforce) or refresh MX hosts
        const config = await tenant.scope.mtaSts.get(id);
        if (!config?.enabled) return err('MTA-STS not enabled for this domain', 404);
        if (!tenant.hasCloudflare()) return cfFailure(new CfNotConfiguredError());

        const body = await parseBody<{ mode?: string; refresh_mx?: boolean }>(request);

        if (body.mode && (body.mode === 'testing' || body.mode === 'enforce')) {
          const newPolicyId = generatePolicyId();
          await updateMtaStsTxtRecord(tenant, domain.domain, config.mta_sts_record_id!, newPolicyId);
          await tenant.scope.mtaSts.updateMode(id, body.mode, newPolicyId);
          logAudit(tenant, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.mode_change',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            before_value: { mode: config.mode, policy_id: config.policy_id },
            after_value: { mode: body.mode, policy_id: newPolicyId },
          }, ctx);
          if (config.mta_sts_record_id) {
            logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.update', resource_type: 'dns_record', resource_id: config.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, before_value: { content: `v=STSv1; id=${config.policy_id}` }, after_value: { content: `v=STSv1; id=${newPolicyId}` } }, ctx);
          }
          track(tenant, { event: 'mta_sts.mode_change', from: config.mode, to: body.mode }); // fire-and-forget
          return json({ ok: true, mode: body.mode, policy_id: newPolicyId });
        }

        if (body.refresh_mx) {
          const oldMxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
          let mxHosts: string[];
          try {
            mxHosts = await discoverMxHosts(domain.domain);
          } catch (e) {
            return err(`DNS lookup failed: ${e instanceof Error ? e.message : String(e)}`, 502);
          }
          if (mxHosts.length === 0) return err('No MX records found', 400);
          const newPolicyId = generatePolicyId();
          await updateMtaStsTxtRecord(tenant, domain.domain, config.mta_sts_record_id!, newPolicyId);
          await tenant.scope.mtaSts.updateMxHosts(id, mxHosts.join(','), newPolicyId);
          logAudit(tenant, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.mx_refresh',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            before_value: { mx_hosts: oldMxHosts, policy_id: config.policy_id },
            after_value: { mx_hosts: mxHosts, policy_id: newPolicyId },
          }, ctx);
          return json({ ok: true, mx_hosts: mxHosts, policy_id: newPolicyId });
        }

        return err('nothing to update', 400);
      }

      if (method === 'DELETE') {
        // Disable + remove DNS records
        const config = await tenant.scope.mtaSts.get(id);
        if (!config) return new Response(null, { status: 204 });

        if (tenant.hasCloudflare()) {
          try {
            await deprovisionMtaSts(
              tenant,
              domain.domain,
              {
                mta_sts_record_id: config.mta_sts_record_id ?? null,
                tls_rpt_record_id: config.tls_rpt_record_id ?? null,
                cname_record_id: config.cname_record_id ?? null,
              }
            );
          } catch (e) {
            console.warn(`[mta-sts] deprovision DNS failed for ${domain.domain}:`, e);
          }
        }

        logAudit(tenant, {
              actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'mta_sts.disable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { mode: config.mode, mx_hosts: config.mx_hosts?.split(',').filter(Boolean) ?? [], policy_id: config.policy_id },
        }, ctx);
        // Log each DNS record deleted
        const rd = tenant.settings.reportsDomain;
        if (config.mta_sts_record_id) logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, before_value: { type: 'TXT', name: `_mta-sts.${domain.domain}`, content: `v=STSv1; id=${config.policy_id}` } }, ctx);
        if (config.tls_rpt_record_id && rd) logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.tls_rpt_record_id, resource_name: `_smtp._tls.${domain.domain}`, before_value: { type: 'TXT', name: `_smtp._tls.${domain.domain}`, content: `v=TLSRPTv1; rua=mailto:tls-rpt@${rd}` } }, ctx);
        if (config.cname_record_id) logAudit(tenant, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.cname_record_id, resource_name: `mta-sts.${domain.domain}`, before_value: { type: 'CNAME', name: `mta-sts.${domain.domain}` } }, ctx);
        track(tenant, { event: 'mta_sts.disable' }); // fire-and-forget
        await tenant.scope.mtaSts.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    // MTA-STS policy file endpoint — GET /api/domains/:id/mta-sts/policy
    const mtaStsPolicyMatch = path.match(/^\/api\/domains\/([^/]+)\/mta-sts\/policy$/);
    if (mtaStsPolicyMatch && method === 'GET') {
      const id = parseInt(mtaStsPolicyMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const config = await tenant.scope.mtaSts.get(id);
      if (!config?.enabled) return err('MTA-STS not enabled', 404);
      const mxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
      const policy = buildPolicyFile(config.mode, mxHosts, 86400);
      return new Response(policy, { headers: { 'Content-Type': 'text/plain' } });
    }

    // GET /api/audit-log — admin only
    if (path === '/api/audit-log' && method === 'GET') {
      if (!isAdmin) return err('admin required', 403);
      const page  = parseInt(url.searchParams.get('page')  ?? '1',  10);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const results = await tenant.scope.audit.list({
        page:      isNaN(page)  ? 1  : page,
        limit:     isNaN(limit) ? 50 : limit,
        action:    url.searchParams.get('action')    ?? undefined,
        domain_id: url.searchParams.get('domain_id') ?? undefined,
        actor_id:  url.searchParams.get('actor_id')  ?? undefined,
        since:     url.searchParams.get('since')  ? parseInt(url.searchParams.get('since')!, 10)  : undefined,
        until:     url.searchParams.get('until')  ? parseInt(url.searchParams.get('until')!, 10)  : undefined,
      });
      return json({ entries: results, page, limit });
    }

    // POST /api/domains/bulk-import — admin-only fast path: insert + provision N domains at once
    if (path === '/api/domains/bulk-import' && method === 'POST') {
      if (!isAdmin) return err('admin required', 403);
      const body = await parseBody<{ domains?: string }>(request);
      if (!body.domains || typeof body.domains !== 'string') return err('domains (string) is required', 400);
      const list = parseDomainList(body.domains);
      if (list.length === 0) return err('no valid domains provided', 400);
      if (list.length > 50) return err('too many domains: limit is 50 per request', 400);
      if (!tenant.settings.reportsDomain) return err(REPORTS_DOMAIN_MISSING, 400);
      const results = await bulkInsertDomains(
        tenant,
        list,
        { actorId: userBySession?.id, actorEmail: userBySession?.email, ctx },
      );
      const imported = results.filter(r => r.status === 'imported').length;
      return json({ imported, total: results.length, results }, imported > 0 ? 201 : 200);
    }

    // GET /api/domains/ct-discover?domain= — admin-only: enumerate subdomains via crt.sh
    if (path === '/api/domains/ct-discover' && method === 'GET') {
      if (!isAdmin) return err('admin required', 403);
      const rootDomain = url.searchParams.get('domain')?.toLowerCase().trim();
      if (!rootDomain) return err('domain query param is required', 400);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(rootDomain)) return err('invalid domain format', 400);
      try {
        const subdomains = await fetchSubdomains(rootDomain);
        return json({ domain: rootDomain, subdomains });
      } catch (e: any) {
        return err(e.message ?? 'CT log lookup failed', 502);
      }
    }

    // /api/cloudflare/* and /api/domains/:id/connection — Cloudflare connections (owner/admin)
    const connectionResponse = await handleConnectionRoutes(request, tenant, ctx, { role: workspace.role, user: userBySession });
    if (connectionResponse) return connectionResponse;

    // /api/domains/:id/hosted — hosted records (MODE=saas only)
    const hostedResponse = await handleHostedRoutes(request, tenant, ctx, { id: userBySession?.id, email: userBySession?.email });
    if (hostedResponse) return hostedResponse;

    // /api/analytics, /api/domains/:id/analytics — read-only sender inventory, trend, fixes, readiness
    const analyticsResponse = await handleAnalyticsRoutes(request, tenant);
    if (analyticsResponse) return analyticsResponse;

    // /api/keys — per-user API keys
    const keyResponse = await handleKeyRoutes(request, tenant, ctx, { role: workspace.role, kind: (workspace as AuthedWorkspace).kind, user: userBySession });
    if (keyResponse) return keyResponse;

    return err('not found', 404);
  } catch (e: any) {
    if (e instanceof CfConnectionError || e instanceof CfZoneNotAllowedError || e instanceof TokenKeyError || e instanceof TokenEnvelopeError) return cfFailure(e);
    if (e?.status && e?.message) return err(e.message, e.status);
    console.error('API error', e);
    return err('internal server error', 500);
  }
}
