// Analytics: "what is happening with my mail", read-only and tenant-scoped like every other route.
//
//   GET /api/analytics?days=7|30|90              workspace-wide: pass-rate trend, sender inventory, what to fix next, per-domain readiness
//   GET /api/domains/:id/analytics?days=…        the same for one domain, with live enforcement readiness
//
// The window (`days`, default 30, at most 90) shapes the trend and the inventory. Fixes and readiness always
// judge the last 30 days, so the advice does not flip when someone switches the chart to 7 days.

import { createResolver, isDmarcRecord } from '@inbox-angel/dns-checks';
import type { SenderRow, TrendRow } from '@inbox-angel/db';
import { parseDmarcTags } from '../dmarc/rollout';
import type { TenantContext } from '../tenancy/context';
import { buildFixes, fixScore, type Fix } from './fixes';
import { assessReadiness, type PolicyState, type Readiness } from './readiness';
import { buildSenders, pct, type AlignModes } from './senders';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

const ROUTE = /^\/api\/(?:domains\/([^/]+)\/)?analytics$/;
const ADVICE_DAYS = 30;
const MAX_SENDERS = 200;
const MAX_WORKSPACE_FIXES = 25;

export interface AnalyticsDeps {
  /** The live DMARC record: a string, null for "no record", undefined when the lookup failed. */
  lookupDmarc?: (domain: string) => Promise<string | null | undefined>;
}

async function liveDmarc(domain: string): Promise<string | null | undefined> {
  try {
    const txt = await createResolver().txt(`_dmarc.${domain}`);
    if (txt.status === 'error') return undefined;
    return txt.records.find(isDmarcRecord) ?? null;
  } catch {
    return undefined;
  }
}

const dayStart = (unix: number) => Math.floor(unix / 86400) * 86400;
const dayOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/** One entry per calendar day from `since` to `now`, zeros where no report landed. */
export function fillTrend(rows: TrendRow[], since: number, now: number): TrendRow[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: TrendRow[] = [];
  for (let t = Math.floor(since / 86400) * 86400; t <= now; t += 86400) {
    const day = dayOf(t);
    out.push(by.get(day) ?? { day, total: 0, passed: 0, failed: 0 });
  }
  return out;
}

const sum = (rows: TrendRow[]) => {
  const total = rows.reduce((n, r) => n + r.total, 0);
  const passed = rows.reduce((n, r) => n + r.passed, 0);
  return { messages: total, passed, failed: total - passed, pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : null, days_with_reports: rows.filter((r) => r.total > 0).length };
};

function windowDays(url: URL): number {
  const n = parseInt(url.searchParams.get('days') ?? '30', 10);
  return Number.isNaN(n) ? 30 : Math.min(Math.max(n, 1), 90);
}

export async function handleAnalyticsRoutes(request: Request, tenant: TenantContext, deps: AnalyticsDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(ROUTE);
  if (!m) return null;
  if (request.method.toUpperCase() !== 'GET') return err('method not allowed', 405);

  const days = windowDays(url);
  const now = Math.floor(Date.now() / 1000);
  // Whole UTC days: reports are bucketed by the day they start, so a cut mid-day would drop the oldest day.
  const since = dayStart(now) - days * 86400;
  const adviceSince = dayStart(now) - ADVICE_DAYS * 86400;
  const q = tenant.scope.analytics;

  if (m[1] !== undefined) {
    const id = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NaN;
    if (isNaN(id)) return err('invalid domain id', 400);
    const domain = await tenant.scope.domains.getById(id);
    if (!domain) return err('domain not found', 404);

    // One pass over the rows and one over the trend serve both the requested window and the 30-day advice window.
    const [allRows, allTrend, earliest, live] = await Promise.all([
      q.senderRows(id, since, adviceSince, now),
      q.trend(id, Math.min(since, adviceSince)),
      q.earliestReport(id, now),
      (deps.lookupDmarc ?? liveDmarc)(domain.domain),
    ]);
    // Strict alignment only when the published record says so; otherwise relaxed, and the response says which.
    const tags = typeof live === 'string' ? parseDmarcTags(live) : null;
    const align: AlignModes = { spf: tags?.get('aspf')?.toLowerCase() === 's' ? 's' : 'r', dkim: tags?.get('adkim')?.toLowerCase() === 's' ? 's' : 'r' };
    const senders = buildSenders(inWindow(allRows, 'messages'), { now, earliest, align });
    const adviceSenders = buildSenders(inWindow(allRows, 'advice_messages'), { now, earliest, align });
    const fixes = buildFixes({ id, domain: domain.domain, spf_record: domain.spf_record, spf_lookup_count: domain.spf_lookup_count }, adviceSenders);
    const trend = fillTrend(allTrend.filter((r) => r.day >= dayOf(since)), since, now);
    const advice = sum(fillTrend(allTrend.filter((r) => r.day >= dayOf(adviceSince)), adviceSince, now));

    // Live record when readable; otherwise the stored policy and pct, and the response says so.
    const state: PolicyState = live === undefined ? { policy: domain.dmarc_policy, pct: domain.dmarc_pct } : { record: live };
    const readiness = assessReadiness({
      state, messages: advice.messages, passed: advice.passed, daysWithReports: advice.days_with_reports, windowDays: ADVICE_DAYS,
      fixes, newSenders: adviceSenders.filter((s) => s.is_new).length, inherits: domain.parent_id !== null,
    });

    return json({
      days, domain: { id, domain: domain.domain }, totals: sum(trend), trend,
      alignment: { spf: align.spf === 's' ? 'strict' : 'relaxed', dkim: align.dkim === 's' ? 'strict' : 'relaxed', basis: tags ? 'dns' : 'assumed', estimated: true },
      senders: senders.slice(0, MAX_SENDERS), sender_count: senders.length, fixes, readiness: { ...readiness, policy_source: live === undefined ? 'stored' : 'dns' },
    });
  }

  const [allRows, allTrend, earliest, totals] = await Promise.all([
    q.senderRows(null, since, adviceSince, now),
    q.trend(null, Math.min(since, adviceSince)),
    q.earliestReport(null, now),
    q.domainTotals(adviceSince),
  ]);
  const senders = buildSenders(inWindow(allRows, 'messages'), { now, earliest });
  const adviceRows = inWindow(allRows, 'advice_messages');
  const trend = fillTrend(allTrend.filter((r) => r.day >= dayOf(since)), since, now);

  const perDomain = totals.map((d) => {
    const ds = buildSenders(adviceRows.filter((r) => r.domain_id === d.domain_id), { now, earliest });
    const fixes = buildFixes({ id: d.domain_id, domain: d.domain, spf_record: d.spf_record, spf_lookup_count: d.spf_lookup_count }, ds);
    // No DNS fan-out here: the stored policy and pct (pct 0 = testing mode, as rollout.ts stores it).
    const readiness: Readiness = assessReadiness({
      state: { policy: d.dmarc_policy, pct: d.dmarc_pct }, messages: d.total, passed: d.passed, daysWithReports: d.days_with_reports, windowDays: ADVICE_DAYS,
      fixes, newSenders: ds.filter((s) => s.is_new).length,
    });
    return { d, fixes, readiness };
  });

  const fixes: Fix[] = perDomain.flatMap((p) => p.fixes).sort((a, b) => fixScore(b) - fixScore(a) || a.id.localeCompare(b.id)).slice(0, MAX_WORKSPACE_FIXES);

  return json({
    days, totals: sum(trend), trend, alignment: { spf: 'relaxed', dkim: 'relaxed', basis: 'assumed', estimated: true },
    senders: senders.slice(0, MAX_SENDERS), sender_count: senders.length, fixes,
    domains: perDomain.map(({ d, readiness }) => ({
      domain_id: d.domain_id, domain: d.domain, dmarc_policy: d.dmarc_policy, messages: d.total, pass_rate: d.total > 0 ? pct(d.passed, d.total) : null,
      readiness: { status: readiness.status, headline: readiness.headline, next: readiness.next, policy_source: 'stored' as const },
    })),
  });
}

/** The rows that saw mail in the window, with `messages` set to that window's count. */
function inWindow(rows: SenderRow[], key: 'messages' | 'advice_messages'): SenderRow[] {
  return rows.map((r) => ({ ...r, messages: r[key] })).filter((r) => r.messages > 0);
}
