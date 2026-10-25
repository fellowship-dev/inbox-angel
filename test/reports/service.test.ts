import { describe, it, expect } from 'vitest';
import { createResolver } from '@inbox-angel/dns-checks';
import { buildReport } from '@inbox-angel/report';
import { checkDomain } from '@inbox-angel/dns-checks';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { makeTenant } from '../helpers/tenant';
import { getDomainReport } from '../../src/reports/service';

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

  it('cannot read another workspace domain by guessed id', async () => {
    const { tenant, id } = await world();
    await expect(getDomainReport(makeTenant({ db: tenant.db, workspaceId: 'foreign' }), id)).rejects.toMatchObject({ status: 404 });
  });
});
