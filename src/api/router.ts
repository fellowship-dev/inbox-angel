// REST API router for InboxAngel Worker.
// All /api/* routes require authentication via requireAuth().
// Auth provider is pluggable — see src/api/auth.ts.
//
// Unauthenticated:
//   GET  /health                              — liveness probe
//   GET  /api/version                         — running vs latest version
//   POST /api/check-sessions                  — create a free-check session
//   GET  /api/check-sessions/:token           — poll for free-check result
//   POST /api/monitor                         — subscribe to change alerts (unauthenticated)
//   GET  /api/auth/status                     — any admin configured? + env prefill
//   POST /api/auth/setup                      — first-time admin creation
//   POST /api/auth/login                      — password login → session token
//   POST /api/auth/logout                     — clear session token
//   POST /api/auth/forgot                     — send password reset email
//   POST /api/auth/reset                      — set new password via reset token
//   GET  /api/invites/:token                  — invite info
//   POST /api/invites/:token/accept           — accept invite + create user
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
//   GET    /api/domains/:id/rollout-next      — current pct= step, next step, DNS preview, safety
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
//   GET    /api/team                          — list users (admin only)
//   POST   /api/team/invite                   — send invite link (admin only)
//   DELETE /api/team/:id                      — remove team member (admin only)
//
// Self-hosted lazy init: if base domain is configured (via wizard/D1) and no domain exists yet,
// the first authenticated request auto-provisions the domain (no bootstrap call needed).

import { Env } from '../index';
import { requireAuth, AuthError } from './auth';
import { version } from '../../package.json';
import {
  getAllDomains,
  getDomainById,
  insertDomain,
  updateDomainDmarcPolicy,
  updateDomainSpfLookupCount,
  getRecentReports,
  getCheckResultByToken,
  insertMonitorSubscription,
  getDomainStats,
  getTopFailingSources,
  getReportSourcesByDate,
  getDayReportSummary,
  getDomainExportData,
  getCheckSummary,
  getAnomalySources,
  getAllSources,
  getSetting,
  setSetting,
  persistConfig,
  getMonitorSubsByDomain,
  setMonitorSubActive,
  setDomainAlertsEnabled,
  getUserByEmail,
  getUserBySession,
  getAllUsers,
  insertUser,
  setUserSession,
  deleteUser,
  getInvite,
  insertInvite,
  markInviteUsed,
  insertPasswordResetToken,
  getPasswordResetToken,
  markResetTokenUsed,
  getSpfFlattenConfig,
  upsertSpfFlattenConfig,
  updateSpfFlattenResult,
  updateSpfFlattenError,
  deleteSpfFlattenConfig,
  getMtaStsConfig,
  insertMtaStsConfig,
  updateMtaStsMode,
  updateMtaStsMxHosts,
  deleteMtaStsConfig,
  getTlsReportSummary,
  getAuditLog,
  updateDomainRollout,
} from '../db/queries';
import { hashPassword, verifyPassword } from './password';
import { deprovisionDomain, provisionDomain } from '../dns/provision';
import { parseDomainList, bulkInsertDomains } from '../domains/bulk';
import { fetchSubdomains } from '../domains/ct';
import { ensureEmailRouting, registerEmailRoutingDestination } from '../setup/email-routing';
import { track } from '../telemetry';
import { reportsDomain, fromEmail, enrichEnv, getZoneId, getAccountId, getBaseDomain, resetEnvCache } from '../env-utils';
import { logAudit } from '../audit/log';
import { flattenSpf, restoreSpf, collectIps, buildFlatRecord } from '../email/spf-flattener';
import { getNextStep, getCurrentStepIndex, buildStepRecord, PASS_RATE_THRESHOLD, ROLLOUT_SEQUENCE } from '../dmarc/rollout';
import { lookupSpf, lookupDmarc, countSpfLookupsFromRecord } from '../email/dns-check';
import { createResolver, isDmarcRecord, isSpfRecord } from '../../packages/dns-checks/src';
import { getAllDkimSelectors } from '../../dashboard/src/email-service-providers';
import {
  provisionMtaSts,
  updateMtaStsTxtRecord,
  deprovisionMtaSts,
  discoverMxHosts,
  generatePolicyId,
  buildPolicyFile,
  patchCfDnsRecord,
} from '../email/mta-sts';

// ── Helpers ───────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
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

async function parseBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw { status: 400, message: 'Invalid JSON body' };
  }
}

// ── Route handlers ────────────────────────────────────────────

async function getDomainsHandler(env: Env): Promise<Response> {
  const { results } = await getAllDomains(env.DB);
  return json({ domains: results });
}

async function addDomain(request: Request, env: Env, userEmail?: string, ctx?: ExecutionContext, actorId?: string): Promise<Response> {
  const body = await parseBody<{ domain?: string }>(request);
  if (!body.domain || typeof body.domain !== 'string') {
    return err('domain is required', 400);
  }

  const domain = body.domain.toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return err('invalid domain format', 400);
  }

  const rdomain = reportsDomain();
  if (!rdomain) return err('Reports domain not configured — complete the setup wizard first', 500);

  // Fixed rua address — routing is by XML policy_domain, not by address encoding
  const ruaAddress = `rua@${rdomain}`;

  // Compute the auth record name (but do NOT create it — wizard handles DNS provisioning)
  const authRecordName = `${domain}._report._dmarc.${rdomain}`;

  // Insert domain row — no DNS writes here; all DNS changes require explicit user action
  let domainId: number;
  try {
    const result = await insertDomain(env.DB, { domain, rua_address: ruaAddress });
    domainId = result.meta.last_row_id as number;
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return err('domain already registered', 409);
    throw e;
  }

  track(env, { event: 'domain.add' }); // fire-and-forget, non-blocking

  logAudit(env.DB!, {
    actor_id: actorId ?? null, actor_email: userEmail ?? null, actor_type: 'user',
    action: 'domain.add',
    resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
    after_value: { domain, rua_address: ruaAddress },
  }, ctx);

  // Auto-subscribe the adding user to monitoring alerts
  const email = userEmail;
  if (email) {
    await insertMonitorSubscription(env.DB, {
      email: email.toLowerCase().trim(),
      domain,
      session_token: null,
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
            return updateDomainSpfLookupCount(env.DB!, domainId, spf.lookup_count);
          }
        })
        .catch(e => console.warn('[domain.add] background SPF walk failed (non-fatal):', e))
    );
  }

  // Return the full domain row so the frontend has the ID
  const domainRow = await getDomainById(env.DB, domainId);

  // If subdomain, fetch parent context for the inheritance-aware wizard
  let parent_context: { domain: string; dmarc_policy: string | null; dmarc_sp: string | null; has_dmarc: boolean } | null = null;
  if (domainRow?.parent_id) {
    const parentRow = await getDomainById(env.DB, domainRow.parent_id);
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

async function deleteDomain(env: Env, domainId: string, actor?: { id?: string; email?: string }, ctx?: ExecutionContext): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain) return err('domain not found', 404);

  await env.DB.prepare('DELETE FROM domains WHERE id = ?')
    .bind(id)
    .run();

  logAudit(env.DB!, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action: 'domain.remove',
    resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
    before_value: { domain: domain.domain, rua_address: domain.rua_address },
  }, ctx);

  // Best-effort cleanup of the CF DNS record (non-fatal if it fails)
  if (domain.dns_record_id) {
    const rdomain = reportsDomain();
    const recordName = rdomain ? `${domain.domain}._report._dmarc.${rdomain}` : domain.dns_record_id;
    logAudit(env.DB!, {
      actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
      action: 'dns.delete',
      resource_type: 'dns_record', resource_id: domain.dns_record_id, resource_name: recordName,
      before_value: { type: 'TXT', name: recordName, content: 'v=DMARC1;', ttl: 3600 },
    }, ctx);
    await deprovisionDomain(env, domain.dns_record_id).catch(e =>
      console.warn(`deprovisionDomain failed for domain ${id}:`, e)
    );
  }

  return new Response(null, { status: 204 });
}

async function getReports(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
  const { results } = await getRecentReports(env.DB, limit);
  return json({ reports: results });
}

async function getReport(env: Env, reportId: string): Promise<Response> {
  const id = parseInt(reportId, 10);
  if (isNaN(id)) return err('invalid report id', 400);

  const report = await env.DB
    .prepare('SELECT r.*, d.domain FROM aggregate_reports r JOIN domains d ON d.id = r.domain_id WHERE r.id = ?')
    .bind(id)
    .first();

  if (!report) return err('report not found', 404);

  const { results: records } = await env.DB
    .prepare('SELECT * FROM report_records WHERE report_id = ? ORDER BY count DESC')
    .bind(id)
    .all();

  return json({ report, records });
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json() as { success: boolean };
    return data.success;
  } catch {
    return false;
  }
}

async function getCheckResults(env: Env): Promise<Response> {
  // Return the last 20 results for monitored domains
  const { results: domains } = await getAllDomains(env.DB);
  const domainNames = domains.map(d => d.domain);

  if (domainNames.length === 0) return json({ results: [] });

  const placeholders = domainNames.map(() => '?').join(', ');
  const { results } = await env.DB
    .prepare(`SELECT * FROM check_results WHERE from_domain IN (${placeholders}) ORDER BY created_at DESC LIMIT 20`)
    .bind(...domainNames)
    .all();

  return json({ results });
}

async function getDomainStatsSummary(env: Env, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain) return err('domain not found', 404);

  const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
  const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const { results } = await getDomainStats(env.DB, id, since);
  return json({ domain: domain.domain, days, stats: results });
}

async function exportDomainData(env: Env, domainId: string): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain) return err('domain not found', 404);

  const { results } = await getDomainExportData(env.DB, id);

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

async function getDomainCheckSummary(env: Env, domainId: string): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain) return err('domain not found', 404);

  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const summary = await getCheckSummary(env.DB, id, since);
  if (!summary) return err('check summary not found', 404);

  return json(summary);
}

async function getDomainReportByDate(env: Env, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('date param required (YYYY-MM-DD)', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain) return err('domain not found', 404);

  const [summary, { results: sources }] = await Promise.all([
    getDayReportSummary(env.DB, id, date),
    getReportSourcesByDate(env.DB, id, date),
  ]);

  return json({ date, domain: domain.domain, summary: summary ?? { total: 0, passed: 0, failed: 0 }, sources });
}

async function getDomainSources(env: Env, domainId: string, url: URL): Promise<Response> {
  const id = parseInt(domainId, 10);
  if (isNaN(id)) return err('invalid domain id', 400);

  const domain = await getDomainById(env.DB, id);
  if (!domain) return err('domain not found', 404);

  const rawDays = parseInt(url.searchParams.get('days') ?? '7', 10);
  const days = Math.min(isNaN(rawDays) ? 7 : rawDays, 90);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const { results } = await getTopFailingSources(env.DB, id, since);
  return json({ sources: results });
}

// ── Main router ───────────────────────────────────────────────

export async function handleApi(
  request: Request,
  envRaw: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const res = await _handleApi(request, envRaw, ctx);
  return withSecurityHeaders(res);
}

async function _handleApi(
  request: Request,
  envRaw: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  await enrichEnv(envRaw, envRaw.DB);
  const env = envRaw;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

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
    const GH_RAW = 'https://raw.githubusercontent.com/Fellowship-dev/inbox-angel-worker/main/package.json';
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
      release_url: 'https://github.com/Fellowship-dev/inbox-angel-worker/releases/latest',
    });
  }

  // POST /api/check-sessions — generate a unique free-check email for a browser session
  if (path === '/api/check-sessions' && method === 'POST') {
    const rd = reportsDomain();
    if (!rd) return err('Reports domain not configured — complete the setup wizard first', 500);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const token = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => chars[b % chars.length]).join('');
    track(env, { event: 'check.created' }); // fire-and-forget
    return json({ token, email: `${token}@${rd}` }, 201);
  }

  // GET /api/check-sessions/:token — poll until the check email has been processed
  const sessionMatch = path.match(/^\/api\/check-sessions\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    const result = await getCheckResultByToken(env.DB, sessionMatch[1]);
    if (!result) return json({ status: 'pending' }, 202);
    return json({ status: 'done', result });
  }

  // POST /api/monitor — subscribe to change alerts for a domain (unauthenticated)
  if (path === '/api/monitor' && method === 'POST') {
    const body = await parseBody<{ email?: string; session_token?: string }>(request);
    if (!body.email || !body.session_token) return err('email and session_token are required', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);

    const checkResult = await getCheckResultByToken(env.DB, body.session_token);
    if (!checkResult) return err('check result not found — send the test email first', 404);

    await insertMonitorSubscription(env.DB, {
      email: body.email.toLowerCase().trim(),
      domain: checkResult.from_domain,
      session_token: body.session_token,
      spf_record: checkResult.spf_record,
      dmarc_policy: checkResult.dmarc_policy,
      dmarc_pct: null,  // not stored in check_results; will be populated on first cron run
      dmarc_record: checkResult.dmarc_record,
    });

    return json({ domain: checkResult.from_domain, email: body.email }, 201);
  }

  // GET /api/auth/status — any admin configured? + env prefill
  if (path === '/api/auth/status' && method === 'GET') {
    const admin = await env.DB!.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).first();
    const [tsKeyRow, customDomainRow, telemetryRow] = await Promise.all([
      getSetting(env.DB!, 'turnstile_site_key'),
      getSetting(env.DB!, 'custom_domain'),
      getSetting(env.DB!, 'telemetry_opted_in'),
    ]);
    const { results: existingDomains } = await getAllDomains(env.DB!);
    const baseDomain = getBaseDomain();
    return json({
      configured: !!admin,
      prefill: { name: '', email: '' },
      telemetry_default: telemetryRow?.value === 'true',
      turnstile_site_key: tsKeyRow?.value ?? null,
      custom_domain: customDomainRow?.value ?? null,
      base_domain: baseDomain ?? null,
      has_domain: existingDomains.length > 0 || !!baseDomain,
    });
  }

  // POST /api/auth/setup — first-time admin creation (only if no users exist)
  if (path === '/api/auth/setup' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.AUTH_LIMITER) {
      const { success } = await env.AUTH_LIMITER.limit({ key: ip });
      if (!success) return err('Too many requests — try again later', 429);
    }
    const admin = await env.DB!.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).first();
    if (admin) return err('already configured — use /api/auth/login', 409);

    const body = await parseBody<{ name?: string; email?: string; password?: string; telemetry?: boolean; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);

    const tsSecretRow = await getSetting(env.DB!, 'turnstile_secret_key');
    if (tsSecretRow?.value) {
      const tsToken = body.cf_turnstile_token;
      if (!tsToken) return err('Bot check failed', 403);
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      const valid = await verifyTurnstile(tsToken, tsSecretRow.value, ip);
      if (!valid) return err('Bot check failed', 403);
    }

    const hash = await hashPassword(body.password);
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();
    const email = body.email.toLowerCase().trim();

    await insertUser(env.DB!, { id, email, name: body.name?.trim() || email, password_hash: hash, role: 'admin' });
    await setUserSession(env.DB!, id, token);
    if (body.telemetry !== undefined) await setSetting(env.DB!, 'telemetry_opted_in', body.telemetry ? 'true' : 'false');

    logAudit(env.DB!, {
      actor_id: id, actor_email: email, actor_type: 'user',
      action: 'auth.setup',
      resource_type: 'user', resource_id: id, resource_name: email,
      after_value: { email, role: 'admin' },
      meta: { ip },
    }, ctx);
    track(env, { event: 'instance.born' }); // fire-and-forget

    // Check if a domain is already configured (from env var or D1)
    const baseDomain = getBaseDomain();
    const { results: existingDomains } = await getAllDomains(env.DB!);
    const has_domain = existingDomains.length > 0 || !!baseDomain;

    return json({ token, has_domain }, 201);
  }

  // POST /api/auth/login — verify password → new session token
  if (path === '/api/auth/login' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.AUTH_LIMITER) {
      const { success } = await env.AUTH_LIMITER.limit({ key: ip });
      if (!success) return err('Too many requests — try again later', 429);
    }
    const body = await parseBody<{ email?: string; password?: string; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);

    const tsSecretRow = await getSetting(env.DB!, 'turnstile_secret_key');
    if (tsSecretRow?.value) {
      const tsToken = body.cf_turnstile_token;
      if (!tsToken) return err('Bot check failed', 403);
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      const valid = await verifyTurnstile(tsToken, tsSecretRow.value, ip);
      if (!valid) return err('Bot check failed', 403);
    }

    const user = await getUserByEmail(env.DB!, body.email.toLowerCase().trim());
    if (!user || !user.password_hash) return err('invalid credentials', 401);

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) return err('invalid credentials', 401);

    const token = crypto.randomUUID();
    await setUserSession(env.DB!, user.id, token);
    logAudit(env.DB!, {
      actor_id: user.id, actor_email: user.email, actor_type: 'user',
      action: 'auth.login',
      resource_type: 'user', resource_id: user.id, resource_name: user.email,
      meta: { ip: request.headers.get('CF-Connecting-IP') ?? 'unknown' },
    }, ctx);
    return json({ token });
  }

  // POST /api/auth/logout — clear session token
  if (path === '/api/auth/logout' && method === 'POST') {
    const key = request.headers.get('x-api-key') ?? '';
    const user = await getUserBySession(env.DB!, key);
    if (user) {
      await setUserSession(env.DB!, user.id, null);
      logAudit(env.DB!, {
          actor_id: user.id, actor_email: user.email, actor_type: 'user',
        action: 'auth.logout',
        resource_type: 'user', resource_id: user.id, resource_name: user.email,
      }, ctx);
    }
    return json({ ok: true });
  }

  // POST /api/auth/forgot — generate reset token + send email
  if (path === '/api/auth/forgot' && method === 'POST') {
    const body = await parseBody<{ email?: string }>(request);
    if (!body.email) return err('email is required', 400);

    const user = await getUserByEmail(env.DB!, body.email.toLowerCase().trim());
    // Always return 200 — don't reveal whether email exists
    if (user) {
      const token = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      await insertPasswordResetToken(env.DB!, token, user.id, expiresAt);
      logAudit(env.DB!, {
          actor_id: user.id, actor_email: user.email, actor_type: 'user',
        action: 'auth.password_reset',
        resource_type: 'user', resource_id: user.id, resource_name: user.email,
        meta: { phase: 'requested' },
      }, ctx);

      const origin = new URL(request.url).origin;
      const resetUrl = `${origin}/#/reset/${token}`;
      const emailBody = `Hi ${user.name},\n\nYou requested a password reset for your InboxAngel account.\n\nClick the link below to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email — your password won't change.\n\nInboxAngel`;

      const fe = fromEmail(env);
      if (env.SEND_EMAIL && fe) {
        try {
          await env.SEND_EMAIL.send({
            from: { name: 'InboxAngel', email: fe },
            to: [user.email],
            subject: 'Reset your InboxAngel password',
            text: emailBody,
          });
        } catch (e) {
          console.error('[auth] reset email send failed:', e);
        }
      } else {
        console.log(`[auth] reset link for ${user.email}: ${resetUrl}`);
      }
    }
    return json({ ok: true });
  }

  // POST /api/auth/reset — set new password using reset token
  if (path === '/api/auth/reset' && method === 'POST') {
    const body = await parseBody<{ token?: string; password?: string }>(request);
    if (!body.token || !body.password) return err('token and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);

    const resetToken = await getPasswordResetToken(env.DB!, body.token);
    if (!resetToken || resetToken.used_at || resetToken.expires_at < Math.floor(Date.now() / 1000)) {
      return err('reset link is invalid or has expired', 400);
    }

    const hash = await hashPassword(body.password);
    const sessionToken = crypto.randomUUID();
    await env.DB!.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(hash, resetToken.user_id).run();
    await setUserSession(env.DB!, resetToken.user_id, sessionToken);
    await markResetTokenUsed(env.DB!, body.token);
    logAudit(env.DB!, {
      actor_id: resetToken.user_id, actor_type: 'user',
      action: 'auth.password_reset',
      resource_type: 'user', resource_id: resetToken.user_id,
      meta: { phase: 'completed' },
    }, ctx);
    return json({ token: sessionToken });
  }

  // GET /api/invites/:token — get invite info (unauthenticated, for the accept page)
  const inviteTokenMatch = path.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteTokenMatch && method === 'GET') {
    const invite = await getInvite(env.DB!, inviteTokenMatch[1]);
    if (!invite || invite.used_at || invite.expires_at < Math.floor(Date.now() / 1000)) {
      return err('invite not found or expired', 404);
    }
    return json({ email: invite.email, invited_by: invite.invited_by, role: invite.role });
  }

  // POST /api/invites/:token/accept — set name+password, create user, return session
  if (inviteTokenMatch && method === 'POST') {
    const invite = await getInvite(env.DB!, inviteTokenMatch[1]);
    if (!invite || invite.used_at || invite.expires_at < Math.floor(Date.now() / 1000)) {
      return err('invite not found or expired', 404);
    }
    const body = await parseBody<{ name?: string; password?: string }>(request);
    if (!body.name || !body.password) return err('name and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);

    const existing = await getUserByEmail(env.DB!, invite.email);
    if (existing) return err('an account with this email already exists', 409);

    const hash = await hashPassword(body.password);
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();

    await insertUser(env.DB!, { id, email: invite.email, name: body.name.trim(), password_hash: hash, role: invite.role as 'admin' | 'member' });
    await setUserSession(env.DB!, id, token);
    await markInviteUsed(env.DB!, invite.token);
    logAudit(env.DB!, {
      actor_id: id, actor_email: invite.email, actor_type: 'user',
      action: 'auth.invite_accepted',
      resource_type: 'user', resource_id: id, resource_name: invite.email,
      after_value: { email: invite.email, role: invite.role, invited_by: invite.invited_by },
    }, ctx);
    return json({ token }, 201);
  }

  // All /api/* routes require auth
  if (!path.startsWith('/api/')) {
    return err('not found', 404);
  }

  // Resolve session: env API_KEY match → users table session.
  // First-run setup is POST /api/auth/setup (only while no admin exists); there is
  // no auto-generated credential.
  const requestKey = request.headers.get('x-api-key') ?? '';
  let effectiveApiKey: string | undefined;
  let userBySession: Awaited<ReturnType<typeof getUserBySession>> = null;
  if (env.API_KEY && requestKey === env.API_KEY) {
    // Direct API_KEY match (curl/automation)
    effectiveApiKey = env.API_KEY;
  } else if (requestKey) {
    // Try session-based auth (dashboard login) — only when a key is actually provided
    userBySession = await getUserBySession(env.DB!, requestKey);
    if (userBySession) {
      effectiveApiKey = requestKey;
    }
  }
  try {
    await requireAuth(request, { ...env, API_KEY: effectiveApiKey });
  } catch (e) {
    if (e instanceof AuthError) return err(e.message, e.status);
    return err('authentication error', 401);
  }

  try {
    // POST /api/settings/base-domain — wizard step 0: set the base domain
    if (path === '/api/settings/base-domain' && method === 'POST') {
      const body = await parseBody<{ domain?: string }>(request);
      if (!body.domain || typeof body.domain !== 'string') return err('domain is required', 400);

      const domain = body.domain.toLowerCase().trim();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return err('invalid domain format', 400);

      // Persist base domain + derived values to D1
      const rd = `reports.${domain}`;
      const fe = `noreply@${rd}`;
      const ruaAddress = `rua@${rd}`;
      await persistConfig(env.DB!, {
        base_domain: domain,
        reports_domain: rd,
        from_email: fe,
      });

      // Reset caches so enrichEnv picks up new values
      resetEnvCache();
      await enrichEnv(env, env.DB);

      // Resolve zone_id + account_id from the new domain
      const zoneId = getZoneId();
      const accountId = getAccountId();
      if (zoneId && accountId) {
        await persistConfig(env.DB!, { zone_id: zoneId, account_id: accountId });
      }

      // Create the domain row if it doesn't exist yet, then mark it as default.
      // This is the first domain configured — it becomes the infrastructure hub.
      const existing = await getAllDomains(env.DB!);
      const alreadyHas = existing.results.some(d => d.domain === domain);
      let domainId: number | undefined;
      if (!alreadyHas) {
        const result = await insertDomain(env.DB!, { domain, rua_address: ruaAddress });
        domainId = result.meta.last_row_id as number;
        track(env, { event: 'domain.add' });
        logAudit(env.DB!, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
          action: 'domain.add',
          resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
          after_value: { domain, rua_address: ruaAddress, source: 'wizard' },
        }, ctx);
      } else {
        domainId = existing.results.find(d => d.domain === domain)?.id;
      }

      // Atomically designate this domain as the default (clears any existing default first)
      if (domainId) {
        await env.DB!.batch([
          env.DB!.prepare('UPDATE domains SET is_default = 0'),
          env.DB!.prepare('UPDATE domains SET is_default = 1 WHERE id = ?').bind(domainId),
        ]);
      }

      return json({
        ok: true,
        domain,
        domain_id: domainId,
        reports_domain: rd,
        zone_id: zoneId ?? null,
        account_id: accountId ?? null,
      }, 201);
    }

    // GET /api/zones — list CF account zones for zone picker (requires CLOUDFLARE_API_TOKEN)
    if (path === '/api/zones' && method === 'GET') {
      if (!env.CLOUDFLARE_API_TOKEN) return err('Cloudflare API token not configured', 400);
      try {
        const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=200&status=active', {
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        });
        const data = await res.json() as {
          success: boolean;
          result?: { id: string; name: string; status: string }[];
          errors?: { message: string }[];
        };
        if (!data.success) {
          const msg = data.errors?.map(e => e.message).join(', ') ?? 'CF API error';
          return err(msg, 502);
        }
        const zones = (data.result ?? []).map(z => ({ id: z.id, name: z.name, status: z.status }));
        return json({ zones });
      } catch {
        return err('Failed to fetch zones from Cloudflare', 502);
      }
    }

    // GET /api/domains
    if (path === '/api/domains' && method === 'GET') {
      return await getDomainsHandler(env);
    }
    // POST /api/domains
    if (path === '/api/domains' && method === 'POST') {
      const userEmail = userBySession?.email;
      return await addDomain(request, env, userEmail, ctx, userBySession?.id);
    }
    // GET /api/domains/:id/stats
    const domainStatsMatch = path.match(/^\/api\/domains\/([^/]+)\/stats$/);
    if (domainStatsMatch && method === 'GET') {
      return await getDomainStatsSummary(env, domainStatsMatch[1], url);
    }
    // GET /api/domains/:id/reports?date=YYYY-MM-DD
    const domainReportsMatch = path.match(/^\/api\/domains\/([^/]+)\/reports$/);
    if (domainReportsMatch && method === 'GET') {
      return await getDomainReportByDate(env, domainReportsMatch[1], url);
    }
    // GET /api/domains/:id/sources
    const domainSourcesMatch = path.match(/^\/api\/domains\/([^/]+)\/sources$/);
    if (domainSourcesMatch && method === 'GET') {
      return await getDomainSources(env, domainSourcesMatch[1], url);
    }
    // GET /api/domains/:id/explore?days=30
    const exploreMatch = path.match(/^\/api\/domains\/([^/]+)\/explore$/);
    if (exploreMatch && method === 'GET') {
      const id = parseInt(exploreMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);
      const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
      const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const { results } = await getAllSources(env.DB, id, since);
      return json({ days, domain: domain.domain, sources: results });
    }
    // GET /api/domains/:id/anomalies?days=30
    const anomaliesMatch = path.match(/^\/api\/domains\/([^/]+)\/anomalies$/);
    if (anomaliesMatch && method === 'GET') {
      const id = parseInt(anomaliesMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);
      const rawDays = parseInt(url.searchParams.get('days') ?? '30', 10);
      const days = Math.min(isNaN(rawDays) ? 30 : rawDays, 90);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const { results } = await getAnomalySources(env.DB, id, since);
      return json({ days, domain: domain.domain, anomalies: results });
    }
    // GET /api/domains/:id/export — CSV download (requires normal session/API key auth)
    const exportMatch = path.match(/^\/api\/domains\/([^/]+)\/export$/);
    if (exportMatch && method === 'GET') {
      return await exportDomainData(env, exportMatch[1]);
    }
    // GET /api/domains/:id/check-summary — DMARC/SPF/DKIM/MTA-STS summary for PDF report
    const checkSummaryMatch = path.match(/^\/api\/domains\/([^/]+)\/check-summary$/);
    if (checkSummaryMatch && method === 'GET') {
      return await getDomainCheckSummary(env, checkSummaryMatch[1]);
    }
    // GET /api/domains/:id/dns-check — check if user has added the _dmarc TXT record
    const dnsCheckMatch = path.match(/^\/api\/domains\/([^/]+)\/dns-check$/);
    if (dnsCheckMatch && method === 'GET') {
      const id = parseInt(dnsCheckMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
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
        if (found) track(env, { event: 'domain.dns_verified' }); // fire-and-forget
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
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);
      if (!domain.dns_record_id) return err('domain is not CF-managed — update DNS manually', 400);
      if (!env.CLOUDFLARE_API_TOKEN) return err('Cloudflare credentials not configured', 400);

      const body = await parseBody<{ policy?: string }>(request);
      const policy = body.policy;
      if (!policy || !['none', 'quarantine', 'reject'].includes(policy)) {
        return err('policy must be none, quarantine, or reject', 400);
      }

      // Build updated TXT record, preserving rua= and any pct= from existing record
      const rd = reportsDomain();
      const ruaPart = rd ? `; rua=mailto:${domain.rua_address}` : '';
      const newRecord = `v=DMARC1; p=${policy}${ruaPart}`;

      try {
        await patchCfDnsRecord({ CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN }, domain.dns_record_id, newRecord);
      } catch (e: any) {
        return err(e.message ?? 'CF DNS patch failed', 500);
      }

      const prevPolicy = domain.dmarc_policy ?? 'none';
      await updateDomainDmarcPolicy(env.DB, id, policy);

      logAudit(env.DB, {
          actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
        action: 'domain.dmarc_mode_change',
        resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
        before_value: { policy: prevPolicy },
        after_value: { policy, record: newRecord },
      }, ctx);
      track(env, { event: 'domain.dmarc_mode_change', from: prevPolicy, to: policy });

      return json({ ok: true, policy, record: newRecord });
    }

    // GET /api/domains/:id/onboarding-status — DMARC + SPF + DKIM + routing health check
    const onboardingMatch = path.match(/^\/api\/domains\/([^/]+)\/onboarding-status$/);
    if (onboardingMatch && method === 'GET') {
      const id = parseInt(onboardingMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      const rd = reportsDomain();
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
          const admin = await env.DB!.prepare(`SELECT email FROM users WHERE role = 'admin' LIMIT 1`).first<{ email: string }>();
          const admin_email = admin?.email ?? null;
          const accountId = getAccountId();
          if (!env.CLOUDFLARE_API_TOKEN) {
            destination_debug = 'no CF token';
          } else if (!accountId) {
            destination_debug = 'account ID not resolved';
          } else if (!admin?.email) {
            destination_debug = 'no admin email found';
          } else {
            try {
              const destRes = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`,
                { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
              );
              const destData = await destRes.json() as { success?: boolean; result?: { email: string; verified?: string | null }[]; errors?: { message: string }[] };
              if (!destData.success) {
                destination_debug = `CF API error: ${destData.errors?.map(e => e.message).join(', ') ?? 'unknown'}`;
              } else {
                const match = destData.result?.find(d => d.email === admin.email);
                if (!match) {
                  destination_debug = `email ${admin.email} not found in routing destinations`;
                } else if (!match.verified) {
                  destination_debug = 'email found but not yet verified';
                } else {
                  destination_verified = true;
                }
              }
            } catch (e) {
              destination_debug = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
            }
          }

          return { ...mxResult, destination_verified, admin_email, ...(destination_debug ? { destination_debug } : {}) };
        })(),

        // DKIM: CF API if available (full zone scan), else DoH for common selectors
        // Scans both TXT and CNAME records — providers like Proton Mail use CNAMEs for DKIM
        (async () => {
          if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
            try {
              const zoneId = getZoneId();
              const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
              const [txtRes, cnameRes] = await Promise.all([
                fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&per_page=100`, { headers }),
                fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&per_page=100`, { headers }),
              ]);
              const txtData = await txtRes.json() as { result?: { name: string; content: string }[] };
              const cnameData = await cnameRes.json() as { result?: { name: string; content: string }[] };
              const allRecords = [...(txtData.result ?? []), ...(cnameData.result ?? [])];
              const found = allRecords.filter(r => r.name.includes('_domainkey'));
              if (found.length > 0 || txtData.result !== undefined) {
                return { selectors: found.map(r => ({ name: r.name, record: r.content })), source: 'cf' as const };
              }
            } catch {}
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

      const spfFlatConfig = await getSpfFlattenConfig(env.DB, domain.id);
      return json({
        domain_id: domain.id,
        domain: domain.domain,
        rua_address: domain.rua_address,
        cf_available: !!(env.CLOUDFLARE_API_TOKEN && getZoneId()),
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
      if (!env.CLOUDFLARE_API_TOKEN || !getZoneId()) return err('Cloudflare credentials not configured', 400);
      const rd = reportsDomain();
      if (!rd) return err('Reports domain not configured — complete the setup wizard first', 400);

      let result;
      try {
        result = await ensureEmailRouting(env);
      } catch (e: any) {
        return err(e.message ?? 'Email routing setup failed', 500);
      }
      if (result.status !== 'skipped') {
        logAudit(env.DB!, {
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
      const accountId = getAccountId();
      if (!env.CLOUDFLARE_API_TOKEN || !accountId) return err('Cloudflare credentials not configured', 400);
      const admin = await env.DB!.prepare(`SELECT email FROM users WHERE role = 'admin' LIMIT 1`).first<{ email: string }>();
      if (!admin?.email) return err('no admin email found', 400);
      const sent = await registerEmailRoutingDestination(env.CLOUDFLARE_API_TOKEN, accountId, admin.email);
      return json({ ok: true, email: admin.email, verification_sent: sent });
    }

    // POST /api/domains/:id/apply-dmarc — create or update _dmarc.{domain} TXT in CF DNS
    const applyDmarcMatch = path.match(/^\/api\/domains\/([^/]+)\/apply-dmarc$/);
    if (applyDmarcMatch && method === 'POST') {
      const id = parseInt(applyDmarcMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);
      if (!env.CLOUDFLARE_API_TOKEN || !getZoneId()) return err('Cloudflare credentials not configured', 400);

      const body = await parseBody<{ record?: string }>(request);
      if (!body.record) return err('record content is required', 400);

      const zoneId = getZoneId()!;
      const token = env.CLOUDFLARE_API_TOKEN;
      const recordName = `_dmarc.${domain.domain}`;

      // Find existing record
      const searchData = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(recordName)}&per_page=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json() as Promise<{ result?: { id: string }[] }>);
      const existingId = searchData.result?.[0]?.id;

      const cfRes = existingId
        ? await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existingId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: body.record }),
          })
        : await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'TXT', name: recordName, content: body.record, ttl: 3600 }),
          });

      const cfData = await cfRes.json() as { success: boolean; result?: { id: string }; errors?: { message: string }[] };
      if (!cfData.success) return err(cfData.errors?.map(e => e.message).join(', ') ?? 'CF DNS update failed', 500);

      logAudit(env.DB!, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: existingId ? 'dns.update' : 'dns.create',
        resource_type: 'dns_record', resource_id: cfData.result?.id ?? '', resource_name: recordName,
        after_value: { type: 'TXT', name: recordName, content: body.record },
      }, ctx);

      // Provision the cross-domain DMARC authorization record if not already present
      let authProvisioned = false;
      const rd = reportsDomain();
      if (rd && !domain.dns_record_id) {
        try {
          const authResult = await provisionDomain(env, domain.domain, {
            db: env.DB!, actor_id: userBySession?.id ?? null,
            actor_email: userBySession?.email ?? null, actor_type: 'user', ctx,
          });
          if (authResult.recordId) {
            await env.DB!.prepare('UPDATE domains SET dns_record_id = ?, auth_record_provisioned = 1 WHERE id = ?')
              .bind(authResult.recordId, id).run();
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
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);
      if (!env.CLOUDFLARE_API_TOKEN || !getZoneId()) return err('Cloudflare credentials not configured', 400);

      // Block if SPF flattening is active — wizard edits would be overwritten by next cron run
      const flatConfig = await getSpfFlattenConfig(env.DB, id);
      if (flatConfig?.enabled) return err('SPF flattening is active for this domain. Disable it before editing the SPF record manually.', 409);

      const body = await parseBody<{ record?: string; confirm_overwrite?: boolean }>(request);
      if (!body.record) return err('record content is required', 400);
      if (!body.record.startsWith('v=spf1')) return err('SPF record must start with v=spf1', 400);
      if (!body.record.includes('all')) return err('SPF record must end with an all mechanism', 400);

      const zoneId = getZoneId()!;
      const token = env.CLOUDFLARE_API_TOKEN;
      const recordName = domain.domain;

      // Find existing SPF TXT record
      const searchData = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(recordName)}&per_page=100`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json() as Promise<{ result?: { id: string; content: string }[] }>);
      const existingSpf = searchData.result?.find(r => r.content.replace(/^"|"$/g, '').startsWith('v=spf1'));
      const existingId = existingSpf?.id;

      // Safety: require explicit confirmation when overwriting an existing record
      if (existingSpf && !body.confirm_overwrite) {
        return json({ ok: false, needs_confirmation: true, existing_record: existingSpf.content.replace(/^"|"$/g, ''), proposed_record: body.record }, 200);
      }

      const cfRes = existingId
        ? await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existingId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: body.record }),
          })
        : await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'TXT', name: recordName, content: body.record, ttl: 3600 }),
          });

      const cfData = await cfRes.json() as { success: boolean; result?: { id: string }; errors?: { message: string }[] };
      if (!cfData.success) return err(cfData.errors?.map(e => e.message).join(', ') ?? 'CF DNS update failed', 500);

      logAudit(env.DB!, {
          actor_id: userBySession?.id ?? null, actor_email: userBySession?.email ?? null, actor_type: 'user',
        action: existingId ? 'dns.update' : 'dns.create',
        resource_type: 'dns_record', resource_id: cfData.result?.id ?? '', resource_name: recordName,
        before_value: existingSpf ? { type: 'TXT', name: recordName, content: existingSpf.content } : null,
        after_value: { type: 'TXT', name: recordName, content: body.record },
      }, ctx);

      return json({ ok: true, record: body.record, created: !existingId });
    }

    // POST /api/setup/custom-domain — register inbox-angel.{BASE_DOMAIN} as CF Custom Domain
    if (path === '/api/setup/custom-domain' && method === 'POST') {
      if (!env.CLOUDFLARE_API_TOKEN || !getZoneId()) return err('Cloudflare credentials not configured', 400);
      const accountId = getAccountId();
      if (!accountId) return err('Account ID not available', 400);
      const bd = getBaseDomain();
      if (!bd) return err('Base domain not configured', 400);

      const workerName = env.WORKER_NAME ?? 'inbox-angel-worker';
      const hostname = `inbox-angel.${bd}`;

      const domainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ environment: 'production', hostname, service: workerName, zone_id: getZoneId() }),
      });
      const domainData = await domainRes.json() as { success: boolean; errors?: { message: string }[] };
      if (!domainData.success) {
        const msg = domainData.errors?.map(e => e.message).join(', ') ?? 'Failed to register custom domain';
        return err(msg, 502);
      }

      await setSetting(env.DB!, 'custom_domain', hostname);
      logAudit(env.DB!, {
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
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      const raw = await getSetting(env.DB, `wizard_state_${id}`);
      const defaults = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' };
      const state = raw ? { ...defaults, ...JSON.parse(raw.value) } : defaults;
      return json(state);
    }

    // PUT /api/domains/:id/wizard-state — update step completion states
    const wizardPutMatch = path.match(/^\/api\/domains\/([^/]+)\/wizard-state$/);
    if (wizardPutMatch && method === 'PUT') {
      const id = parseInt(wizardPutMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      const body = await parseBody<Record<string, string>>(request);
      const validSteps = ['domain', 'spf', 'dkim', 'dmarc', 'routing'];
      const validStates = ['not_started', 'complete', 'skipped'];

      // Merge with existing state
      const raw = await getSetting(env.DB, `wizard_state_${id}`);
      const defaults = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' };
      const current = raw ? { ...defaults, ...JSON.parse(raw.value) } : defaults;

      for (const [step, state] of Object.entries(body)) {
        if (validSteps.includes(step) && validStates.includes(state)) {
          current[step] = state;
        }
      }

      await setSetting(env.DB, `wizard_state_${id}`, JSON.stringify(current));
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
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      await env.DB!.batch([
        env.DB!.prepare('UPDATE domains SET is_default = 0'),
        env.DB!.prepare('UPDATE domains SET is_default = 1 WHERE id = ?').bind(id),
      ]);

      // Reset caches so next request re-derives REPORTS_DOMAIN and FROM_EMAIL from new default
      resetEnvCache();

      logAudit(env.DB!, {
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

    // GET /api/domains/:id/rollout-next — current pct= step, next step, DNS preview, safety checks
    const rolloutNextMatch = path.match(/^\/api\/domains\/([^/]+)\/rollout-next$/);
    if (rolloutNextMatch && method === 'GET') {
      const id = parseInt(rolloutNextMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      // Fetch live DMARC record to get current pct=
      let currentRecord: string | null = null;
      let livePct: number | null = null;
      let livePolicy: string | null = null;
      try {
        const txt = await createResolver().txt(`_dmarc.${domain.domain}`);
        if (txt.status === 'error') throw new Error(txt.error); // unknown, not "no record": fall through without live data
        currentRecord = txt.records.find(isDmarcRecord) ?? null;
        if (currentRecord) {
          const pMatch = currentRecord.match(/\bp=(\w+)/);
          const pctMatch = currentRecord.match(/\bpct=(\d+)/);
          livePolicy = pMatch?.[1] ?? null;
          livePct = pctMatch ? parseInt(pctMatch[1], 10) : 100;
        }
      } catch {
        // DNS unavailable — proceed without live data
      }

      // Pass rate from last 30 days
      const since30d = Math.floor(Date.now() / 1000) - 30 * 86400;
      const statsResult = await getDomainStats(env.DB, id, since30d);
      const rows = statsResult.results ?? [];
      const totalMsgs = rows.reduce((n, r) => n + (r.total ?? 0), 0);
      const passedMsgs = rows.reduce((n, r) => n + (r.passed ?? 0), 0);
      const passRate = totalMsgs > 0 ? Math.round((passedMsgs / totalMsgs) * 100) : null;

      // Unknown senders check: sources with no aligned domain in last 7 days
      const since7d = Math.floor(Date.now() / 1000) - 7 * 86400;
      const sourcesResult = await getTopFailingSources(env.DB, id, since7d);
      const unknownSenders = (sourcesResult.results ?? []).filter(
        (s: any) => !s.spf_domain && !s.dkim_domain
      ).length;

      const nextStep = getNextStep(livePolicy, livePct);
      const currentStepIndex = getCurrentStepIndex(livePolicy, livePct);

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
      const recStepIndex = domain.rollout_rec_policy && domain.rollout_rec_pct != null
        ? ROLLOUT_SEQUENCE.findIndex(
            (s) => s.policy === domain.rollout_rec_policy && s.pct === domain.rollout_rec_pct
          )
        : -1;
      const behindSchedule = recStepIndex > currentStepIndex;

      return json({
        current_policy: livePolicy,
        current_pct: livePct,
        current_record: currentRecord,
        current_step_index: currentStepIndex,
        total_steps: ROLLOUT_SEQUENCE.length,
        next_step: nextStep,
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
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      const body = await parseBody<{ policy: string; pct: number }>(request);
      const { policy, pct } = body;
      if (!policy || !['quarantine', 'reject'].includes(policy)) {
        return err('policy must be quarantine or reject', 400);
      }
      if (typeof pct !== 'number' || ![10, 50, 100].includes(pct)) {
        return err('pct must be 10, 50, or 100', 400);
      }

      await updateDomainRollout(env.DB, id, policy, pct);
      return json({ ok: true, rollout_rec_policy: policy, rollout_rec_pct: pct });
    }

    // DELETE /api/domains/:id
    const domainDeleteMatch = path.match(/^\/api\/domains\/([^/]+)$/);
    if (domainDeleteMatch && method === 'DELETE') {
      return await deleteDomain(env, domainDeleteMatch[1], { id: userBySession?.id, email: userBySession?.email }, ctx);
    }
    // GET /api/reports
    if (path === '/api/reports' && method === 'GET') {
      return await getReports(env, url);
    }
    // GET /api/reports/:id
    const reportMatch = path.match(/^\/api\/reports\/([^/]+)$/);
    if (reportMatch && method === 'GET') {
      return await getReport(env, reportMatch[1]);
    }
    // GET /api/check-results
    if (path === '/api/check-results' && method === 'GET') {
      return await getCheckResults(env);
    }

    // GET /api/domains/:id/monitor-subs — list monitoring subscriptions for a domain
    const monitorSubsMatch = path.match(/^\/api\/domains\/(\d+)\/monitor-subs$/);
    if (monitorSubsMatch && method === 'GET') {
      const domain = await getDomainById(env.DB, parseInt(monitorSubsMatch[1], 10));
      if (!domain) return err('domain not found', 404);
      const { results } = await getMonitorSubsByDomain(env.DB, domain.domain);
      return json({ subs: results });
    }

    // PATCH /api/monitor-subs/:id — toggle active status
    const monitorSubPatchMatch = path.match(/^\/api\/monitor-subs\/(\d+)$/);
    if (monitorSubPatchMatch && method === 'PATCH') {
      const body = await parseBody<{ active?: boolean }>(request);
      if (typeof body.active !== 'boolean') return err('active (boolean) is required', 400);
      await setMonitorSubActive(env.DB, parseInt(monitorSubPatchMatch[1], 10), body.active);
      return json({ ok: true });
    }

    // PATCH /api/domains/:id/alerts — toggle domain-level alerts on/off
    const domainAlertsMatch = path.match(/^\/api\/domains\/([^/]+)\/alerts$/);
    if (domainAlertsMatch && method === 'PATCH') {
      const body = await parseBody<{ alerts_enabled?: boolean }>(request);
      if (typeof body.alerts_enabled !== 'boolean') return err('alerts_enabled (boolean) is required', 400);
      await setDomainAlertsEnabled(env.DB, parseInt(domainAlertsMatch[1], 10), body.alerts_enabled);
      return json({ ok: true });
    }

    // GET /api/team — list all users (admin only)
    if (path === '/api/team' && method === 'GET') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const { results } = await getAllUsers(env.DB);
      return json({ users: results, current_user_id: actor.id });
    }

    // POST /api/team/invite — generate one-time invite link (admin only)
    if (path === '/api/team/invite' && method === 'POST') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const body = await parseBody<{ email?: string; role?: string }>(request);
      if (!body.email) return err('email is required', 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return err('invalid email', 400);
      const existing = await getUserByEmail(env.DB, body.email.toLowerCase().trim());
      if (existing) return err('a user with this email already exists', 409);

      const token = crypto.randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days
      const inviteEmail = body.email.toLowerCase().trim();
      const inviteRole = body.role === 'admin' ? 'admin' : 'member';
      await insertInvite(env.DB, {
        token,
        email: inviteEmail,
        role: inviteRole,
        invited_by: actor.email,
        expires_at: expiresAt,
      });
      logAudit(env.DB, {
          actor_id: actor.id, actor_email: actor.email, actor_type: 'user',
        action: 'auth.invite_sent',
        resource_type: 'user', resource_name: inviteEmail,
        after_value: { email: inviteEmail, role: inviteRole, invited_by: actor.email },
      }, ctx);
      return json({ token }, 201);
    }

    // DELETE /api/team/:id — remove a team member (admin only, can't remove self)
    const teamMemberMatch = path.match(/^\/api\/team\/([^/]+)$/);
    if (teamMemberMatch && method === 'DELETE') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      if (actor.id === teamMemberMatch[1]) return err('cannot remove yourself', 400);
      const removed = await getUserByEmail(env.DB, teamMemberMatch[1]).catch(() => null)
        ?? await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(teamMemberMatch[1]).first<{ id: string; email: string; name: string; role: string }>().catch(() => null);
      await deleteUser(env.DB, teamMemberMatch[1]);
      logAudit(env.DB, {
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
      const domain = await getDomainById(env.DB, id);
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
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      const available = !!(env.CLOUDFLARE_API_TOKEN && getZoneId());

      // GET — return current config + availability
      if (method === 'GET') {
        const config = await getSpfFlattenConfig(env.DB, id);
        return json({ available, config: config ?? null, lookup_count: domain.spf_lookup_count ?? null });
      }

      // POST — enable + trigger initial flatten
      if (method === 'POST') {
        if (!available) return err('Cloudflare credentials not configured — complete the setup wizard first', 422);

        const flatEnv = {
          CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN!,
        };

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
          result = await flattenSpf(domain.domain, flatEnv);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Save config with error so user can see it
          await upsertSpfFlattenConfig(env.DB, {
            domain_id: id,
            canonical_record: spfRecord?.raw ?? '',
            lookup_count,
            cf_record_id: null,
          });
          await updateSpfFlattenError(env.DB, id, msg);
          return err(msg, 422);
        }

        await upsertSpfFlattenConfig(env.DB, {
          domain_id: id,
          canonical_record: result.canonical_record,
          lookup_count,
          cf_record_id: result.cf_record_id,
        });
        await updateSpfFlattenResult(env.DB, id, result.flattened_record, result.ip_count, result.cf_record_id);

        logAudit(env.DB, {
              actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'spf_flatten.enable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { spf_record: result.canonical_record },
          after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
        }, ctx);
        if (result.cf_record_id) {
          logAudit(env.DB, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'dns.update',
            resource_type: 'dns_record', resource_id: result.cf_record_id, resource_name: `TXT _spf.${domain.domain}`,
            before_value: { content: result.canonical_record },
            after_value: { content: result.flattened_record },
          }, ctx);
        }

        track(env, { event: 'spf_flatten.enable' }); // fire-and-forget
        const config = await getSpfFlattenConfig(env.DB, id);
        return json({ ok: true, config }, 201);
      }

      // DELETE — disable + restore canonical record
      if (method === 'DELETE') {
        const config = await getSpfFlattenConfig(env.DB, id);
        if (!config) return err('SPF flattening not configured for this domain', 404);

        if (available && config.cf_record_id && config.canonical_record) {
          try {
            await restoreSpf(domain.domain, config.cf_record_id, config.canonical_record, {
              CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN!,
            });
          } catch (e) {
            console.warn(`[spf-flatten] restore failed for ${domain.domain}:`, e);
            // Non-fatal — delete config anyway so user can retry
          }
        }

        logAudit(env.DB, {
              actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'spf_flatten.disable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { spf_record: config.flattened_record ?? config.canonical_record },
          after_value: { spf_record: config.canonical_record },
        }, ctx);
        track(env, { event: 'spf_flatten.disable' }); // fire-and-forget
        await deleteSpfFlattenConfig(env.DB, id);
        return new Response(null, { status: 204 });
      }
    }

    // MTA-STS routes — GET/POST/PATCH/DELETE /api/domains/:id/mta-sts
    const mtaStsMatch = path.match(/^\/api\/domains\/([^/]+)\/mta-sts$/);
    if (mtaStsMatch) {
      const id = parseInt(mtaStsMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const domain = await getDomainById(env.DB, id);
      if (!domain) return err('domain not found', 404);

      if (method === 'GET') {
        const config = await getMtaStsConfig(env.DB, id);
        const tlsSince = Math.floor(Date.now() / 1000) - 30 * 86400; // last 30 days
        const summary = config ? await getTlsReportSummary(env.DB, id, tlsSince) : null;
        return json({ available: !!(env.CLOUDFLARE_API_TOKEN && getZoneId()), config, summary });
      }

      if (method === 'POST') {
        // Enable MTA-STS
        if (!env.CLOUDFLARE_API_TOKEN || !getZoneId() || !reportsDomain()) {
          return err('Cloudflare credentials not configured', 400);
        }
        const existing = await getMtaStsConfig(env.DB, id);
        if (existing?.enabled) return err('MTA-STS already enabled for this domain', 409);

        try {
          const result = await provisionMtaSts(domain.domain, {
            CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
            WORKER_NAME: env.WORKER_NAME ?? 'inbox-angel-worker',
          });
          await insertMtaStsConfig(env.DB, {
            domain_id: id,
            mode: result.mode,
            mx_hosts: result.mx_hosts.join(','),
            policy_id: result.policy_id,
            mta_sts_record_id: result.mta_sts_record_id,
            tls_rpt_record_id: result.tls_rpt_record_id,
            cname_record_id: result.cname_record_id,
          });
          const rd = reportsDomain()!;
          logAudit(env.DB, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.enable',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            after_value: { mode: result.mode, mx_hosts: result.mx_hosts, policy_id: result.policy_id },
          }, ctx);
          // Log each DNS record created
          logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, after_value: { type: 'TXT', name: `_mta-sts.${domain.domain}`, content: `v=STSv1; id=${result.policy_id}` } }, ctx);
          logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.tls_rpt_record_id, resource_name: `_smtp._tls.${domain.domain}`, after_value: { type: 'TXT', name: `_smtp._tls.${domain.domain}`, content: `v=TLSRPTv1; rua=mailto:tls-rpt@${rd}` } }, ctx);
          logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.create', resource_type: 'dns_record', resource_id: result.cname_record_id, resource_name: `mta-sts.${domain.domain}`, after_value: { type: 'CNAME', name: `mta-sts.${domain.domain}`, proxied: true } }, ctx);
          track(env, { event: 'mta_sts.enable' }); // fire-and-forget
          return json({ ok: true, mode: result.mode, mx_hosts: result.mx_hosts });
        } catch (e: any) {
          return err(e.message ?? 'provisioning failed', 500);
        }
      }

      if (method === 'PATCH') {
        // Update mode (testing → enforce) or refresh MX hosts
        const config = await getMtaStsConfig(env.DB, id);
        if (!config?.enabled) return err('MTA-STS not enabled for this domain', 404);
        if (!env.CLOUDFLARE_API_TOKEN || !getZoneId()) return err('Cloudflare credentials not configured', 400);

        const body = await parseBody<{ mode?: string; refresh_mx?: boolean }>(request);
        const patchEnv = { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };

        if (body.mode && (body.mode === 'testing' || body.mode === 'enforce')) {
          const newPolicyId = generatePolicyId();
          await updateMtaStsTxtRecord(config.mta_sts_record_id!, newPolicyId, patchEnv);
          await updateMtaStsMode(env.DB, id, body.mode, newPolicyId);
          logAudit(env.DB, {
                  actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
            action: 'mta_sts.mode_change',
            resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
            before_value: { mode: config.mode, policy_id: config.policy_id },
            after_value: { mode: body.mode, policy_id: newPolicyId },
          }, ctx);
          if (config.mta_sts_record_id) {
            logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.update', resource_type: 'dns_record', resource_id: config.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, before_value: { content: `v=STSv1; id=${config.policy_id}` }, after_value: { content: `v=STSv1; id=${newPolicyId}` } }, ctx);
          }
          track(env, { event: 'mta_sts.mode_change', from: config.mode, to: body.mode }); // fire-and-forget
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
          await updateMtaStsTxtRecord(config.mta_sts_record_id!, newPolicyId, patchEnv);
          await updateMtaStsMxHosts(env.DB, id, mxHosts.join(','), newPolicyId);
          logAudit(env.DB, {
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
        const config = await getMtaStsConfig(env.DB, id);
        if (!config) return new Response(null, { status: 204 });

        if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
          try {
            await deprovisionMtaSts(
              { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN },
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

        logAudit(env.DB, {
              actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user',
          action: 'mta_sts.disable',
          resource_type: 'domain', resource_id: String(id), resource_name: domain.domain,
          before_value: { mode: config.mode, mx_hosts: config.mx_hosts?.split(',').filter(Boolean) ?? [], policy_id: config.policy_id },
        }, ctx);
        // Log each DNS record deleted
        const rd = reportsDomain();
        if (config.mta_sts_record_id) logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.mta_sts_record_id, resource_name: `_mta-sts.${domain.domain}`, before_value: { type: 'TXT', name: `_mta-sts.${domain.domain}`, content: `v=STSv1; id=${config.policy_id}` } }, ctx);
        if (config.tls_rpt_record_id && rd) logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.tls_rpt_record_id, resource_name: `_smtp._tls.${domain.domain}`, before_value: { type: 'TXT', name: `_smtp._tls.${domain.domain}`, content: `v=TLSRPTv1; rua=mailto:tls-rpt@${rd}` } }, ctx);
        if (config.cname_record_id) logAudit(env.DB, { actor_id: userBySession?.id, actor_email: userBySession?.email, actor_type: 'user', action: 'dns.delete', resource_type: 'dns_record', resource_id: config.cname_record_id, resource_name: `mta-sts.${domain.domain}`, before_value: { type: 'CNAME', name: `mta-sts.${domain.domain}` } }, ctx);
        track(env, { event: 'mta_sts.disable' }); // fire-and-forget
        await deleteMtaStsConfig(env.DB, id);
        return new Response(null, { status: 204 });
      }
    }

    // MTA-STS policy file endpoint — GET /api/domains/:id/mta-sts/policy
    const mtaStsPolicyMatch = path.match(/^\/api\/domains\/([^/]+)\/mta-sts\/policy$/);
    if (mtaStsPolicyMatch && method === 'GET') {
      const id = parseInt(mtaStsPolicyMatch[1], 10);
      if (isNaN(id)) return err('invalid domain id', 400);
      const config = await getMtaStsConfig(env.DB, id);
      if (!config?.enabled) return err('MTA-STS not enabled', 404);
      const mxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
      const policy = buildPolicyFile(config.mode, mxHosts, 86400);
      return new Response(policy, { headers: { 'Content-Type': 'text/plain' } });
    }

    // GET /api/audit-log — admin only
    if (path === '/api/audit-log' && method === 'GET') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const page  = parseInt(url.searchParams.get('page')  ?? '1',  10);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const { results } = await getAuditLog(env.DB, {
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
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
      const body = await parseBody<{ domains?: string }>(request);
      if (!body.domains || typeof body.domains !== 'string') return err('domains (string) is required', 400);
      const list = parseDomainList(body.domains);
      if (list.length === 0) return err('no valid domains provided', 400);
      if (list.length > 50) return err('too many domains: limit is 50 per request', 400);
      const results = await bulkInsertDomains(
        { DB: env.DB, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN },
        list,
        { actorId: actor.id, actorEmail: actor.email, ctx },
      );
      const imported = results.filter(r => r.status === 'imported').length;
      return json({ imported, total: results.length, results }, imported > 0 ? 201 : 200);
    }

    // GET /api/domains/ct-discover?domain= — admin-only: enumerate subdomains via crt.sh
    if (path === '/api/domains/ct-discover' && method === 'GET') {
      const actor = await getUserBySession(env.DB, requestKey);
      if (!actor || actor.role !== 'admin') return err('admin required', 403);
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

    return err('not found', 404);
  } catch (e: any) {
    if (e?.status && e?.message) return err(e.message, e.status);
    console.error('API error', e);
    return err('internal server error', 500);
  }
}
