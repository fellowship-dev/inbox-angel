import { checkDomain, createResolver, DOH_ENDPOINTS, type Resolver } from '@inbox-angel/dns-checks';
import { buildReport } from '@inbox-angel/report';
import type { TenantContext } from '../tenancy/context';
import { enrollmentView } from '../domains/service';
import { getAnalytics } from './analytics';
import { buildRemediation } from './remediation';
import type { EvidenceSection, EvidenceProvenance } from './contracts';
import { getGoogleEvidence } from '../metrics/store';

export interface ReportOptions { days?: number; now?: number; resolver?: Resolver; resolvers?: readonly Resolver[] }

/** One read-only report for HTTP, dashboard and agents. Caller supplies an authorized workspace context. */
export async function getDomainReport(tenant: TenantContext, domainId: number, options: ReportOptions = {}) {
  const domain = await tenant.scope.domains.getById(domainId);
  if (!domain) throw Object.assign(new Error('domain not found'), { status: 404 });
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const days = Number.isFinite(options.days) ? Math.min(Math.max(Math.trunc(options.days!), 1), 90) : 30;
  const window = { since: Math.floor(now / 86400) * 86400 - days * 86400, until: now };
  const resolvers = options.resolvers ?? (options.resolver ? [options.resolver] : [createResolver(), createResolver({ endpoint: DOH_ENDPOINTS.google })]);
  const runs = await Promise.all(resolvers.map(resolver => checkDomain(domain.domain, { resolver })));
  const run = runs.find(r => r.dmarc.status !== 'error') ?? runs[0];
  const dns = buildReport({ runs, generatedAt: new Date(now * 1000).toISOString() });
  const analytics = await getAnalytics(tenant, {
    domainId, days, now,
    lookupDmarc: async () => run.dmarc.status === 'error' ? undefined : run.dmarc.record?.raw ?? null,
  });
  const tls = await tenant.scope.reports.tlsSummary(domainId, window.since, window.until);
  const evidence = await tenant.scope.reports.evidence(domainId, window.since, window.until);
  const dates: string[] = [];
  for (let day = window.since; day <= now; day += 86400) dates.push(new Date(day * 1000).toISOString().slice(0, 10));
  const provenance = (source: typeof evidence.dmarc): EvidenceProvenance => ({
    report_count: source.report_count, truncated: source.truncated,
    observations: source.observations.map(({ created_at, ...observation }) => ({
      ...observation, received_at: created_at, receipt_age_seconds: now - created_at,
    })),
    coverage: {
      date_basis: 'report-start-utc', observed_dates: source.observed_dates,
      missing_dates: dates.filter(date => !source.observed_dates.includes(date)), complete_mail_population: false,
    },
    freshness: {
      latest_period_end: source.latest_period_end, latest_received_at: source.latest_received_at,
      period_end_age_seconds: source.latest_period_end === null ? null : now - source.latest_period_end,
      receipt_age_seconds: source.latest_received_at === null ? null : now - source.latest_received_at,
    },
  });
  const google = await getGoogleEvidence(tenant.scope, domainId, window);
  const totals = analytics.totals;
  const section = <T>(source: string, population: string, data: T | null, reason?: string): EvidenceSection<T> => ({
    status: data === null ? 'unavailable' : 'available', ...(reason ? { reason } : {}), source, population, window, data,
  });
  return {
    schema: 'inbox-angel-health/v1' as const,
    domain: { id: domain.id, domain: domain.domain }, generatedAt: dns.generatedAt,
    coverage: { scope: 'shared-domain' as const, product_attribution: false, detail: 'Aggregate observations cover this domain; they cannot be attributed to one product.' },
    intake: enrollmentView(domain, tenant.settings.reportsDomain).intake,
    dns, analytics,
    sections: {
      dmarc: { ...section('dmarc-aggregate', 'Messages represented in received aggregate DMARC reports; not all mail sent', evidence.dmarc.report_count ? { ...totals, unit: 'messages', denominator: totals.messages, alignment: analytics.alignment } : null, evidence.dmarc.report_count ? undefined : 'no_reports'), evidence: provenance(evidence.dmarc) },
      tls: { ...section('tls-rpt', 'SMTP TLS sessions represented in received TLS-RPT reports; not delivery or inbox placement', tls?.report_count ? { ...tls, unit: 'sessions' } : null, tls?.report_count ? undefined : 'no_reports'), evidence: provenance(evidence.tls) },
      google,
      inbox_placement: section('none', 'Recipient inbox versus spam placement', null, 'not_measured'),
    },
    remediation: buildRemediation(dns, 'fixes' in analytics ? analytics.fixes : []),
  };
}
