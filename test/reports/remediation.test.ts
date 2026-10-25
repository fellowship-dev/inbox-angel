import { it, expect } from 'vitest';
import { createResolver } from '@inbox-angel/dns-checks';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { makeTenant } from '../helpers/tenant';
import { seedDomainReports } from '../analytics/world';
import { getDomainReport } from '../../src/reports/service';

it('explains provider-authenticated but unaligned SES mail without inventing account DNS records', async () => {
  const tenant = makeTenant();
  const id = Number((await tenant.scope.domains.insert({ domain: 'x.com', rua_address: 'rua@r.test' })).meta.last_row_id);
  const now = 1792954800;
  await seedDomainReports(tenant.db, tenant.workspaceId, id, 'x.com', [1], [{
    ip: '54.240.1.1', count: 100, pass: false, spf: ['pass', 'amazonses.com'], dkim: ['pass', 'amazonses.com'], reverse_dns: 'out.amazonses.com',
  }], now);
  const resolver = createResolver({ fetch: dohFetch({}) });
  const report = await getDomainReport(tenant, id, { resolver, now });
  const fix = report.remediation.find(f => f.finding.startsWith('authorize:'))!;
  expect(fix.observation.join(' ')).toContain('100');
  expect(fix.steps.join(' ')).toMatch(/DKIM/);
  expect(fix.steps.join(' ')).toMatch(/custom MAIL FROM/);
  expect(fix.prerequisites.join(' ')).toMatch(/account-specific/);
  expect(fix.changes).toEqual([]);
});
