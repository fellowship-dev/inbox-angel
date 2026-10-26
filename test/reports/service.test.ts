import { describe, it, expect } from 'vitest';
import { createResolver } from '@inbox-angel/dns-checks';
import { buildReport } from '@inbox-angel/report';
import { checkDomain } from '@inbox-angel/dns-checks';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { makeTenant } from '../helpers/tenant';
import { getDomainReport } from '../../src/reports/service';
import { seedDomainReports } from '../analytics/world';

async function world() {
  const tenant = makeTenant({ settings: { reportsDomain: undefined } });
  const id = Number((await tenant.scope.domains.insert({ domain: 'x.com', rua_address: '' })).meta.last_row_id);
  return { tenant, id };
}
const now = 1792954800;

describe('shared domain evidence report', () => {
  it('returns real DNS findings immediately and explicit unavailable history/provider metrics', async () => {
    const { tenant, id } = await world();
    const resolver = createResolver({ fetch: dohFetch({}) });
    const report = await getDomainReport(tenant, id, { resolvers: [resolver, createResolver({ fetch: dohFetch({}) })], now });
    const expected = buildReport({ runs: [await checkDomain('x.com', { resolver }), await checkDomain('x.com', { resolver })], generatedAt: new Date(now * 1000).toISOString() });
    expect(report.dns.findings).toEqual(expected.findings);
    expect(report.dns.findings.map(f => f.id)).toContain('dmarc-missing');
    expect(report.sections.dmarc).toMatchObject({ status: 'unavailable', reason: 'no_reports', source: 'dmarc-aggregate' });
    expect(report.sections.google).toMatchObject({ status: 'unavailable', reason: 'not_connected' });
    expect(report.sections.tls).toMatchObject({ status: 'unavailable', reason: 'no_reports' });
    expect(report.sections.dmarc.evidence.coverage.observed_dates).toEqual([]);
    expect(report.sections.dmarc.evidence.coverage.missing_dates).toHaveLength(31);
    expect(report.sections.dmarc.evidence.freshness.latest_received_at).toBeNull();
    expect(report.sections.tls.evidence.observations).toEqual([]);
    expect(report.coverage).toMatchObject({ scope: 'shared-domain', product_attribution: false });
    expect(report.intake.status).toBe('unavailable');
    expect(report.remediation.some(f => f.finding === 'dmarc-missing')).toBe(true);
  });

  it('keeps resolver failures unknown, while authenticated NXDOMAIN supports absence', async () => {
    const { tenant, id } = await world();
    const resolver = createResolver({ fetch: dohFetch({ 'TXT _dmarc.x.com': 'TIMEOUT' }) });
    const report = await getDomainReport(tenant, id, { resolver, now });
    expect(report.dns.lookupFailed.some(f => f.check === 'dmarc')).toBe(true);
    expect(report.dns.findings.map(f => f.id)).not.toContain('dmarc-missing');
  });

  it('bounds TLS evidence to the requested observation window', async () => {
    const { tenant, id } = await world();
    const insert = (begin: number, success: number) => tenant.scope.reports.insertTls({
      domain_id: id, org_name: 'fixture',
      date_begin: begin, date_end: begin + 3600,
      total_success: success, total_failure: 1, failure_details: null, raw_json: null,
    });
    await insert(now - 86400, 10);
    await insert(now + 86400, 1000);
    await insert(now - 40 * 86400, 10000);
    const report = await getDomainReport(tenant, id, { resolver: createResolver({ fetch: dohFetch({}) }), now, days: 7 });
    expect(report.sections.tls).toMatchObject({
      status: 'available', window: { until: now },
      data: { total_success: 10, total_failure: 1, report_count: 1 },
    });
  });

  it('preserves source periods and receipt age, distinguishing observed zero counts from missing dates', async () => {
    const { tenant, id } = await world();
    const begin = Math.floor(now / 86400) * 86400 - 86400;
    const end = begin + 86399;
    await tenant.scope.reports.insertAggregate({ domain_id: id, org_name: 'DMARC reporter', report_id: 'original-source-42', date_begin: begin, date_end: end, total_count: 0, pass_count: 0, fail_count: 0, raw_xml: '<private>never expose</private>' });
    await tenant.scope.reports.insertTls({ domain_id: id, org_name: 'TLS reporter', date_begin: begin, date_end: end, total_success: 0, total_failure: 0, failure_details: 'private', raw_json: 'private' });
    const received = now - 60;
    const db = tenant.env.DB as unknown as ReturnType<typeof import('@inbox-angel/db/testing').createMigratedD1>;
    db.sqlite.prepare('UPDATE aggregate_reports SET created_at = ?').run(received);
    db.sqlite.prepare('UPDATE tls_reports SET created_at = ?').run(received);
    const report = await getDomainReport(tenant, id, { resolver: createResolver({ fetch: dohFetch({}) }), now, days: 2 });
    expect(report.sections.dmarc).toMatchObject({ status: 'available', data: { messages: 0, denominator: 0, pass_rate: null } });
    expect(report.sections.tls).toMatchObject({ status: 'available', data: { total_success: 0, total_failure: 0 } });
    for (const section of [report.sections.dmarc, report.sections.tls]) {
      expect(section.evidence).toMatchObject({
        report_count: 1, truncated: false,
        observations: [{ date_begin: begin, date_end: end, received_at: received, receipt_age_seconds: 60 }],
        coverage: { observed_dates: [new Date(begin * 1000).toISOString().slice(0, 10)], missing_dates: [new Date((begin - 86400) * 1000).toISOString().slice(0, 10), new Date(now * 1000).toISOString().slice(0, 10)] },
        freshness: { latest_period_end: end, latest_received_at: received, receipt_age_seconds: 60 },
      });
      expect(JSON.stringify(section)).not.toContain('private');
    }
    expect(report.sections.dmarc.evidence.observations[0]).toMatchObject({ source_report_id: 'original-source-42', reporter: 'DMARC reporter' });
    expect(report.sections.tls.evidence.observations[0].source_report_id).toBeNull();
  });

  it('caps sanitized source references while retaining full aggregate totals and coverage', async () => {
    const { tenant, id } = await world();
    const begin = Math.floor(now / 86400) * 86400 - 86400;
    for (let i = 0; i < 201; i++) {
      await tenant.scope.reports.insertAggregate({ domain_id: id, org_name: 'reporter', report_id: `source-${i}`, date_begin: begin, date_end: begin + 86399, total_count: 1, pass_count: 1, fail_count: 0, raw_xml: null });
    }
    const report = await getDomainReport(tenant, id, { resolver: createResolver({ fetch: dohFetch({}) }), now, days: 2 });
    expect(report.sections.dmarc.data?.messages).toBe(201);
    expect(report.sections.dmarc.evidence).toMatchObject({ report_count: 201, truncated: true });
    expect(report.sections.dmarc.evidence.observations).toHaveLength(200);
    expect(report.sections.dmarc.evidence.coverage.observed_dates).toHaveLength(1);
  });

  it('cannot read another workspace domain by guessed id', async () => {
    const { tenant, id } = await world();
    await expect(getDomainReport(makeTenant({ db: tenant.db, workspaceId: 'foreign' }), id)).rejects.toMatchObject({ status: 404 });
  });
  it('excludes future DMARC observations from sender advice and history', async () => {
    const { tenant, id } = await world();
    await seedDomainReports(tenant.db, tenant.workspaceId, id, 'x.com', [-1], [{ip:'203.0.113.8',count:1000,pass:false}], now);
    const report = await getDomainReport(tenant, id, {resolver:createResolver({fetch:dohFetch({})}),now});
    expect(report.analytics.senders).toEqual([]);
    expect(report.analytics.fixes).toEqual([]);
    expect(report.analytics.totals.messages).toBe(0);
    expect(report.sections.dmarc.status).toBe('unavailable');
  });
});
