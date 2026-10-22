// Analytics: "what is happening with my mail", read-only and tenant-scoped like every other route.
//
//   GET /api/analytics?days=7|30|90              account-wide: pass-rate trend, sender inventory, what to fix next, per-domain readiness
//   GET /api/domains/:id/analytics?days=…        the same for one domain, with live enforcement readiness
//
// The window (`days`, default 30, at most 90) shapes the trend and the inventory. Fixes and readiness always
// judge the last 30 days, so the advice does not flip when someone switches the chart to 7 days.

import { createResolver, isDmarcRecord } from '@inbox-angel/dns-checks';
import type { TrendRow } from '@inbox-angel/db';
import { parseDmarcTags } from '../dmarc/rollout';
import type { TenantContext } from '../tenancy/context';
import { buildFixes, fixScore, type Fix } from './fixes';
import { assessReadiness, type Readiness } from './readiness';
import { buildSenders, pct } from './senders';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

const ROUTE = /^\/api\/(?:domains\/([^/]+)\/)?analytics$/;
const ADVICE_DAYS = 30;
const MAX_SENDERS = 200;
const MAX_ACCOUNT_FIXES = 25;

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

    const [rows, adviceRows, trendRows, adviceTrend, earliest, live] = await Promise.all([
      q.senderRows(id, since, now),
      days === ADVICE_DAYS ? Promise.resolve(null) : q.senderRows(id, adviceSince, now),
      q.trend(id, since),
      days === ADVICE_DAYS ? Promise.resolve(null) : q.trend(id, adviceSince),
      q.earliestReport(id, now),
      (deps.lookupDmarc ?? liveDmarc)(domain.domain),
    ]);
    const senders = buildSenders(rows, { now, earliest });
    const adviceSenders = adviceRows ? buildSenders(adviceRows, { now, earliest }) : senders;
    const fixes = buildFixes({ id, domain: domain.domain, spf_record: domain.spf_record }, adviceSenders);
    const trend = fillTrend(trendRows, since, now);
    const advice = sum(fillTrend(adviceTrend ?? trendRows, adviceSince, now));

    let policy: string | null;
    let testing = false;
    let source: 'dns' | 'stored';
    if (live === undefined) {
      policy = domain.dmarc_policy; source = 'stored';
    } else if (live === null) {
      policy = null; source = 'dns';
    } else {
      const tags = parseDmarcTags(live);
      policy = tags.get('p')?.toLowerCase() ?? null; testing = tags.get('t')?.toLowerCase() === 'y'; source = 'dns';
    }
    const readiness = assessReadiness({
      policy, testing, messages: advice.messages, passed: advice.passed, daysWithReports: advice.days_with_reports, windowDays: ADVICE_DAYS,
      fixes, newSenders: adviceSenders.filter((s) => s.is_new).length, inherits: domain.parent_id !== null,
    });

    return json({
      days, domain: { id, domain: domain.domain }, totals: sum(trend), trend,
      senders: senders.slice(0, MAX_SENDERS), sender_count: senders.length, fixes, readiness: { ...readiness, policy_source: source },
    });
  }

  const [rows, adviceRows, trendRows, earliest, totals] = await Promise.all([
    q.senderRows(null, since, now),
    q.senderRows(null, adviceSince, now),
    q.trend(null, since),
    q.earliestReport(null, now),
    q.domainTotals(adviceSince),
  ]);
  const senders = buildSenders(rows, { now, earliest });
  const trend = fillTrend(trendRows, since, now);

  const perDomain = totals.map((d) => {
    const own = adviceRows.filter((r) => r.domain_id === d.domain_id);
    const ds = buildSenders(own, { now, earliest });
    const fixes = buildFixes({ id: d.domain_id, domain: d.domain, spf_record: d.spf_record }, ds);
    const readiness: Readiness = assessReadiness({
      policy: d.dmarc_policy, testing: false, messages: d.total, passed: d.passed, daysWithReports: d.days_with_reports, windowDays: ADVICE_DAYS,
      fixes, newSenders: ds.filter((s) => s.is_new).length,
    });
    return { d, fixes, readiness };
  });

  const fixes: Fix[] = perDomain.flatMap((p) => p.fixes).sort((a, b) => fixScore(b) - fixScore(a) || a.id.localeCompare(b.id)).slice(0, MAX_ACCOUNT_FIXES);

  return json({
    days, totals: sum(trend), trend, senders: senders.slice(0, MAX_SENDERS), sender_count: senders.length, fixes,
    domains: perDomain.map(({ d, readiness }) => ({
      domain_id: d.domain_id, domain: d.domain, dmarc_policy: d.dmarc_policy, messages: d.total, pass_rate: d.total > 0 ? pct(d.passed, d.total) : null,
      readiness: { status: readiness.status, headline: readiness.headline, next: readiness.next, policy_source: 'stored' as const },
    })),
  });
}
