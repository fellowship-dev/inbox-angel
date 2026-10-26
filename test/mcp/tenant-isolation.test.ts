import { forWorkspace } from '@inbox-angel/db';
import type { createMigratedD1 } from '@inbox-angel/db/testing';
import { describe, it, expect } from 'vitest';
import { toolWorld } from './tool-fixture';
describe('MCP call authorization', () => {
 it('denies guessed resources and rechecks grants during the same connected client', async () => {
  const world = await toolWorld(), client = await world.connect();
  for (const args of [{ domain: 'foreign.example' }, { domain: 'example.com', workspaceId: 'foreign' }, { domain: 'example.com', productId: 'sibling' }]) {
   const denied = await client.callTool({ name: 'get_email_report', arguments: args });
   expect(denied.isError).toBe(true); expect(denied.structuredContent).toMatchObject({ error: { code: 'forbidden' } });
  }
  await world.scope.access.grants.revoke(world.grantId, Math.floor(Date.now()/1000));
  await expect(client.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } })).rejects.toThrow();
  await client.close();
 });
 it('lists only the consented union, excluding later memberships and sibling mappings', async () => {
  const world = await toolWorld(), client = await world.connect();
  await world.scope.domains.insert({ domain: 'example.com', rua_address: '' });
  await world.scope.domains.insert({ domain: 'sibling.example', rua_address: '' });
  const result = await client.callTool({ name: 'list_domains', arguments: {} });
  expect((result.structuredContent as any).data.domains.map((d: any) => d.domain)).toEqual(['example.com']);
  await client.close();
 });
 it('portfolio union spans only explicit workspaces and shrinks immediately with membership loss', async () => {
  const world=await toolWorld();
  const db=world.tenant.db as unknown as ReturnType<typeof createMigratedD1>;
  db.sqlite.prepare("INSERT INTO users(id,email,name,email_verified) VALUES ('portfolio-user','portfolio@example.com','Owner',1)").run();
  for(const ws of ['ws_second','ws_later']) db.sqlite.prepare('INSERT INTO workspaces(id,name) VALUES (?,?)').run(ws,ws);
  for(const ws of ['ws_default','ws_second','ws_later']) db.sqlite.prepare("INSERT INTO memberships(workspace_id,user_id,role) VALUES (?,'portfolio-user','owner')").run(ws);
  db.sqlite.prepare("UPDATE access_principals SET kind='human',user_id='portfolio-user' WHERE id='service-agent'").run();
  await world.scope.domains.insert({domain:'example.com',rua_address:''});
  const second=forWorkspace(world.tenant.db,'ws_second');
  await second.domains.insert({domain:'second.example',rua_address:''});
  await forWorkspace(world.tenant.db,'ws_later').domains.insert({domain:'later.example',rua_address:''});
  await second.access.grants.create({id:'second-grant',principal_id:'service-agent',workspace_id:'ws_second',domain:'second.example',actions:'["resources:read","reports:read"]',expires_at:Math.floor(Date.now()/1000)+3600});
  const c=await world.connect();
  const listed=await c.callTool({name:'list_domains',arguments:{}});
  expect((listed.structuredContent as any).data.domains.map((d:any)=>d.domain).sort()).toEqual(['example.com','second.example']);
  expect((await c.callTool({name:'get_email_report',arguments:{workspaceId:'ws_later',domain:'later.example'}})).isError).toBe(true);
  db.sqlite.prepare("DELETE FROM memberships WHERE workspace_id='ws_second' AND user_id='portfolio-user'").run();
  expect((await c.callTool({name:'get_email_report',arguments:{workspaceId:'ws_second',domain:'second.example'}})).isError).toBe(true);
  await c.close();
 });
 it('a product cannot attach a known private domain or read its history by enrolling it',async()=>{
  const world=await toolWorld();
  await world.scope.domains.insert({domain:'private.example',rua_address:''});
  await world.scope.access.products.create({id:'product',name:'App'});
  await world.scope.access.grants.create({id:'private-grant',principal_id:'service-agent',workspace_id:world.tenant.workspaceId,product_id:'product',domain:'private.example',actions:'["domains:manage","reports:read"]',expires_at:Math.floor(Date.now()/1000)+3600});
  const c=await world.connect();
  for(const name of ['add_domain','verify_domain','get_email_report']) expect((await c.callTool({name,arguments:{productId:'product',domain:'private.example'}})).isError).toBe(true);
  expect(await world.scope.access.products.mappings('product')).toEqual([]);
  await c.close();
 });

});
