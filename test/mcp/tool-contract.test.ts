import { createResolver } from '@inbox-angel/dns-checks';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { describe, it, expect } from 'vitest';
import { toolWorld } from './tool-fixture';
const names = ['whoami','list_products','list_domains','inspect_domain','add_domain','verify_domain','get_email_report','query_email_metrics','plan_remediation','get_source_status'];
describe('public MCP tool contract', () => {
 it('actual SDK client enrolls, reconnects and receives actionable immediate health evidence', async () => {
  const world = await toolWorld();
  const client = await world.connect();
  const list = await client.listTools();
  expect(list.tools.map(t => t.name).sort()).toEqual(names.sort());
  for (const tool of list.tools) { expect(tool.inputSchema.type).toBe('object'); expect(tool.outputSchema?.type).toBe('object'); }
  const identity = await client.callTool({ name: 'whoami', arguments: {} });
  expect(identity.structuredContent).toMatchObject({ schema: 'inbox-angel-tool/v1', data: { kind: 'service', principalId: 'service-agent' } });
  expect(await world.scope.domains.list()).toHaveLength(0);
  expect((await client.callTool({ name: 'add_domain', arguments: { domain: 'example.com' } })).isError).not.toBe(true);
  await client.close();
  const reconnected = await world.connect();
  const report = await reconnected.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } });
  expect(report.isError).not.toBe(true);
  expect(report.structuredContent).toMatchObject({ data: { report: { schema: 'inbox-angel-health/v1', intake: { status: 'unavailable' }, sections: { dmarc: { status: 'unavailable', reason: 'no_reports' }, google: { reason: 'not_connected' } } } } });
  const data = report.structuredContent as any;
  expect(data.data.report.remediation.some((f: any) => f.finding === 'dmarc-missing' && f.verification.length)).toBe(true);
  expect((await reconnected.callTool({ name: 'verify_domain', arguments: { domain: 'example.com' } })).isError).not.toBe(true);
  for (const name of ['inspect_domain','query_email_metrics','plan_remediation','get_source_status']) {
   const called=await reconnected.callTool({name,arguments:{domain:'example.com'}});
   expect(called.isError, JSON.stringify(called)).not.toBe(true);
  }
  expect(await world.scope.domains.list()).toHaveLength(1);
  await reconnected.close();
 });
 it('rejects malformed hostnames/ranges and never advertises write/send/admin tools', async () => {
  const world = await toolWorld(), client = await world.connect();
  const bad = await client.callTool({ name: 'get_email_report', arguments: { domain: 'https://example.com', days: 999 } });
  expect(bad.isError).toBe(true);
  const tools = await client.listTools();
  expect(tools.tools.some(t => /send|dns_write|grant|credential/.test(t.name))).toBe(false);
  await client.close();
 });
 it('enrolls a preconsented product hostname atomically and resumes after reconnect', async () => {
  const world = await toolWorld();
  await world.scope.access.products.create({ id: 'product', name: 'Named app' });
  await world.scope.access.grants.create({ id: 'product-grant', principal_id: 'service-agent', workspace_id: world.tenant.workspaceId, product_id: 'product', domain: 'new.example.com', actions: '["domains:manage","reports:read","resources:read"]', expires_at: Math.floor(Date.now()/1000)+3600 });
  const client = await world.connect();
  const added = await client.callTool({ name: 'add_domain', arguments: { domain: 'new.example.com', productId: 'product' } });
  expect(added.isError).not.toBe(true);
  await client.close();
  const reconnect = await world.connect();
  const report = await reconnect.callTool({ name: 'get_email_report', arguments: { domain: 'new.example.com', productId: 'product' } });
  expect(report.isError).not.toBe(true);
  expect(report.structuredContent).toMatchObject({data:{resource:{productId:'product'},report:{coverage:{scope:'shared-domain',product_attribution:false}}}});
  expect(await world.scope.access.products.mappings('product')).toHaveLength(1);
  expect((await reconnect.callTool({name:'list_products',arguments:{}})).structuredContent).toMatchObject({data:{products:[{id:'product'}]}});
  await reconnect.close();
 });

 it('hosted product claim survives reconnect and proof creates the domain plus mapping', async () => {
  const world = await toolWorld();
  world.tenant.env.MODE = 'saas';
  await world.scope.access.products.create({id:'hosted-app',name:'Hosted app'});
  await world.scope.access.grants.create({id:'hosted-grant',principal_id:'service-agent',workspace_id:world.tenant.workspaceId,product_id:'hosted-app',domain:'hosted.example.com',actions:'["domains:manage","reports:read"]',expires_at:Math.floor(Date.now()/1000)+3600});
  const c = await world.connect();
  const added=await c.callTool({name:'add_domain',arguments:{domain:'hosted.example.com',productId:'hosted-app'}});
  expect(added.structuredContent).toMatchObject({data:{enrollment:{pending:true}}});
  const claim=(added.structuredContent as any).data.enrollment.claim;
  await c.close();
  const reconnect=await world.connect();
  const repeated=await reconnect.callTool({name:'add_domain',arguments:{domain:'hosted.example.com',productId:'hosted-app'}});
  expect((repeated.structuredContent as any).data.enrollment.claim.id).toBe(claim.id);
  world.context.reportOptions!.resolver=createResolver({fetch:dohFetch({['TXT '+claim.txt_name]:[claim.txt_value]})});
  const verified=await reconnect.callTool({name:'verify_domain',arguments:{domain:'hosted.example.com',productId:'hosted-app'}});
  expect(verified.structuredContent).toMatchObject({data:{verified:true}});
  expect(await world.scope.access.products.mappings('hosted-app')).toHaveLength(1);
  expect((await reconnect.callTool({name:'get_email_report',arguments:{domain:'hosted.example.com',productId:'hosted-app'}})).isError).not.toBe(true);
  await reconnect.close();
 });

});
