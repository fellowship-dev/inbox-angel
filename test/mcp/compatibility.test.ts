import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
let runtime: Miniflare;
const origin = 'https://ia.example.com';
const key = 'ias_runtime_test_credential_random_material';
beforeAll(async () => {
 const source = `
import { coreWorker } from './src/index.ts';
import { withMcpAuthorization } from './src/auth/mcp-issuer.ts';
import { createInboxMcpHandler } from './src/mcp/transport.ts';
import { createResolver } from '@inbox-angel/dns-checks';
const resolver = createResolver({fetch: async () => ({ok:true,status:200,json:async()=>({Status:3}),text:async()=>'',headers:{get:()=>null}})});
export default withMcpAuthorization(coreWorker,createInboxMcpHandler({reportOptions:{resolvers:[resolver,resolver],now:1792954800}}));`;
 const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'runtime-u4.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd','worker','browser'], external: ['cloudflare:*','node:*'], write: false });
 runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundled.outputFiles[0].text }], compatibilityDate: '2026-05-22', compatibilityFlags: ['nodejs_compat','global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], d1Databases: ['DB'], bindings: { BETTER_AUTH_URL: origin } });
 const db = await runtime.getD1Database('DB');
 await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)').run();
 for (const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) {
  for (const statement of (await readFile(resolve('migrations',name),'utf8')).replace(/--[^\n]*/g,'').split(';').filter(s=>s.trim())) await db.prepare(statement).run();
  await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name).run();
 }
 await db.prepare("INSERT INTO access_principals(id,workspace_id,name,kind) VALUES ('agent','ws_default','Runtime agent','service')").run();
 await db.prepare("INSERT INTO access_grants(id,workspace_id,principal_id,domain,actions,expires_at) VALUES ('grant','ws_default','agent','example.com',?,?)").bind(JSON.stringify(['resources:read','reports:read','domains:manage','remediation:plan']),Math.floor(Date.now()/1000)+3600).run();
 await db.prepare("INSERT INTO access_credentials(id,workspace_id,principal_id,name,key_hash,prefix,expires_at) VALUES ('key','ws_default','agent','runtime',?,'ias_runtime',?)").bind(createHash('sha256').update(key).digest('hex'),Math.floor(Date.now()/1000)+3600).run();
},30000);
afterAll(async()=>{await runtime?.dispose();});
async function client(protocolVersion?: string) {
 const transport = new StreamableHTTPClientTransport(new URL(origin+'/mcp'), { authProvider: { token: async()=>key }, protocolVersion, fetch: async (input,init) => runtime.dispatchFetch(String(input),init) as unknown as Response });
 const c = new Client({name:'Inbox Angel headless acceptance',version:'1.0'}, { versionNegotiation: { mode: protocolVersion ? 'legacy' : { pin: '2026-07-28' } } });
 await c.connect(transport);
 expect(transport.protocolVersion).toBe(protocolVersion ?? '2026-07-28');
 return c;
}
describe('real Worker SDK compatibility',()=>{
 it('modern SDK client receives a useful report across reconnects using real OAuth key validation and D1',async()=>{
  const c = await client();
  expect((await c.callTool({name:'add_domain',arguments:{domain:'example.com'}})).isError).not.toBe(true);
  await c.close();
  const reconnect = await client();
  const report=await reconnect.callTool({name:'get_email_report',arguments:{domain:'example.com'}});
  expect(report.isError).not.toBe(true);
  expect(report.structuredContent).toMatchObject({data:{report:{schema:'inbox-angel-health/v1',sections:{google:{reason:'not_connected'}}}}});
  expect((report.structuredContent as any).data.report.remediation.some((f:any)=>f.finding==='dmarc-missing')).toBe(true);
  const denied=await reconnect.callTool({name:'get_email_report',arguments:{domain:'foreign.example'}});
  expect(denied.isError).toBe(true);
  await reconnect.close();
 },15000);
 it('named legacy stateless SDK profile completes tools/call',async()=>{
  const c = await client('2025-11-25');
  expect((await c.callTool({name:'whoami',arguments:{}})).structuredContent).toMatchObject({data:{kind:'service'}});
  await c.close();
 });
 it('revoked machine credential is denied on the next real tool request',async()=>{
  const c = await client();
  const db=await runtime.getD1Database('DB');
  await db.prepare("UPDATE access_credentials SET revoked_at=1 WHERE id='key'").run();
  await expect(c.callTool({name:'get_email_report',arguments:{domain:'example.com'}})).rejects.toThrow();
  await c.close();
 });
});
