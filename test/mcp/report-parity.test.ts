import { describe, it, expect } from 'vitest';
import { toolWorld } from './tool-fixture';
import { getDomainReport } from '../../src/reports/service';
import { loadTenant } from '../../src/tenancy/load';
describe('MCP shared report parity', () => {
 it('returns identical evidence/fixes to the HTTP/dashboard report service', async () => {
  const world = await toolWorld(), client = await world.connect();
  const id = Number((await world.scope.domains.insert({ domain: 'example.com', rua_address: '' })).meta.last_row_id);
  const canonical = await getDomainReport(await loadTenant(world.tenant.env, { workspaceId: world.tenant.workspaceId }), id, world.context.reportOptions);
  const actual = await client.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } });
  expect((actual.structuredContent as any).data.report).toEqual(canonical);
  const metrics = await client.callTool({ name: 'query_email_metrics', arguments: { domain: 'example.com', source: 'dmarc' } });
  expect((metrics.structuredContent as any).data.sections.dmarc).toEqual(canonical.sections.dmarc);
  const remediation = await client.callTool({ name: 'plan_remediation', arguments: { domain: 'example.com' } });
  expect((remediation.structuredContent as any).data.fixes).toEqual(canonical.remediation);
  await client.close();
 });
});
