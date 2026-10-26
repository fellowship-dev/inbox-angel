// Real workerd + KV + D1 contract; no provider mocks and no network grants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
let runtime: Miniflare;
let bundledWorker = ''; 
const origin = 'https://ia.example.com';
const proof = 'runtime-installer-proof-32-characters-minimum';
const ctxWorker = `
import { coreWorker } from './src/index.ts';
import { withMcpAuthorization, resolveMcpIdentity } from './src/auth/mcp-issuer.ts';
export default withMcpAuthorization(coreWorker,{async fetch(req,env,ctx){
 const subject=await resolveMcpIdentity(env,ctx.props);
 return Response.json({principalId:subject?.principalId,kind:subject?.kind});
}});`;
async function fetch(path: string, init?: RequestInit) { return runtime.dispatchFetch(origin + path, { ...init, redirect: 'manual' }); }
const body = (data: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const cookieOf = (response: Response) => response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
let cookie = '', clientId = '';
beforeAll(async () => {
 const bundled = await build({ stdin: { contents: ctxWorker, resolveDir: process.cwd(), sourcefile: 'runtime-u3.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd','worker','browser'], external: ['cloudflare:*','node:*'], write: false });
 bundledWorker = bundled.outputFiles[0].text;
 runtime = new Miniflare({ modules: [{type:'ESModule',path:'worker.mjs',contents:bundledWorker}], compatibilityDate: '2026-05-22', compatibilityFlags: ['nodejs_compat','global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], d1Databases: ['DB'], bindings: { BETTER_AUTH_URL: origin, BOOTSTRAP_SECRET: proof, MCP_DCR_ENABLED: '1' }, assets: undefined });
 const db = await runtime.getD1Database('DB');
 await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)').run();
 for (const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) {
  const sql = (await readFile(resolve('migrations', name), 'utf8')).replace(/--[^\n]*/g,'');
  for(const statement of sql.split(';').filter(s=>s.trim())) await db.prepare(statement).run();
  await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name).run();
 }
 const setups = await Promise.all(['owner@example.com','racer@example.com'].map(email=>fetch('/api/auth/setup', { ...body({email,password:'runtime-test-password'}), headers: { 'content-type':'application/json','x-inbox-angel-bootstrap':proof } })));
 expect(setups.filter(r=>r.status===201)).toHaveLength(1);
 const setup=setups.find(r=>r.status===201)!; cookie = cookieOf(setup as unknown as Response);
 expect((await db.prepare("SELECT COUNT(*) n FROM memberships WHERE role='owner'").first() as any).n).toBe(1);
 const registration = await fetch('/oauth/register', body({ client_name:'Runtime public client', redirect_uris:['https://client.example/callback'], grant_types:['authorization_code','refresh_token'], response_types:['code'],token_endpoint_auth_method:'none' }));
 expect(registration.status,await registration.clone().text()).toBe(201);
 clientId = (await registration.json() as any).client_id;
}, 30000);
afterAll(async()=>{await runtime?.dispose();});
describe('real Workers OAuth contract',()=>{
 it('publishes installation discovery and rejects missing credentials',async()=>{
  const metadata=await fetch('/.well-known/oauth-protected-resource/mcp');
  expect(metadata.status).toBe(200); expect(await metadata.json()).toMatchObject({resource:origin+'/mcp',authorization_servers:[origin]});
  expect((await fetch('/mcp')).status).toBe(401);
 });
 it('requires PKCE and rejects wrong audiences',async()=>{
  const query=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:'https://client.example/callback',scope:'inbox-angel',resource:origin+'/mcp',state:'opaque-state'});
  const noPkce=await fetch('/oauth/authorize?'+query,{headers:{cookie}});
  expect(noPkce.status).toBe(400);
  query.set('code_challenge','A'.repeat(43));query.set('code_challenge_method','S256');query.set('resource','https://other.example/mcp');
  expect((await fetch('/oauth/authorize?'+query,{headers:{cookie}})).status).toBe(400);
 });
 it('rejects private and special-use client metadata destinations in the real fetch boundary',async()=>{
  for (const destination of ['https://127.0.0.1/client.json','https://[::1]/client.json','https://169.254.169.254/latest/meta-data/']) {
   const query=new URLSearchParams({response_type:'code',client_id:destination,redirect_uri:'https://client.example/callback',scope:'inbox-angel',resource:origin+'/mcp',code_challenge:'A'.repeat(43),code_challenge_method:'S256'});
   const response=await fetch('/oauth/authorize?'+query,{headers:{cookie}});
   expect(response.status).toBeGreaterThanOrEqual(400);
  }
 },30000);
 it('rejects unbound/cross-origin consent submission',async()=>{
  const form=new URLSearchParams({handle:'fake',workspaceId:'ws_default',domain:'example.com',actions:'reports:read',days:'7'});
  const response=await fetch('/oauth/authorize',{method:'POST',headers:{cookie,origin:'https://attacker.example','content-type':'application/x-www-form-urlencoded'},body:form.toString()});
  expect(response.status).toBe(403);
 });
 it('expired consent storage cannot mint a connection',async()=>{
  const query=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:'https://client.example/callback',scope:'inbox-angel',resource:origin+'/mcp',code_challenge:'A'.repeat(43),code_challenge_method:'S256'});
  const page=await fetch('/oauth/authorize?'+query,{headers:{cookie}});
  const handle=(await page.text()).match(/name="handle" value="([^"]+)"/)![1];
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(handle))).toString('hex');
  const kv=await runtime.getKVNamespace('OAUTH_KV');await kv.delete('transaction:'+hash);
  const response=await fetch('/oauth/authorize',{method:'POST',headers:{cookie:cookie+'; '+cookieOf(page as unknown as Response),origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,workspaceId:'ws_default',domain:'example.com',actions:'reports:read',days:'7'}).toString()});
  expect(response.status).toBe(400);
 });
 it('issues code + PKCE tokens and denies refresh/calls after D1 disconnect with KV records retained',async()=>{
  const verifier='runtime-pkce-verifier-at-least-forty-three-characters';
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  const challenge=Buffer.from(digest).toString('base64url');
  const query=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:'https://client.example/callback',scope:'inbox-angel',resource:origin+'/mcp',state:'opaque-state',code_challenge:challenge,code_challenge_method:'S256'});
  const page=await fetch('/oauth/authorize?'+query,{headers:{cookie}});
  const html=await page.text();expect(page.status,html).toBe(200);expect(html).not.toContain(proof);expect(html).not.toContain('runtime-test-password');
  const handle=html.match(/name="handle" value="([^"]+)"/)?.[1];expect(handle).toBeTruthy();
  const consentCookie=cookie+'; '+cookieOf(page as unknown as Response);
  const form=new URLSearchParams({handle:handle!,workspaceId:'ws_default',domain:'example.com',actions:'reports:read',days:'7'});
  const approved=await fetch('/oauth/authorize',{method:'POST',headers:{cookie:consentCookie,origin,'content-type':'application/x-www-form-urlencoded'},body:form.toString()});
  expect(approved.status,await approved.clone().text()).toBe(302);
  const redirect=new URL(approved.headers.get('location')!);expect(redirect.searchParams.get('iss')).toBe(origin);
  const code=redirect.searchParams.get('code')!;
  const tokenBody=new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:verifier,redirect_uri:'https://client.example/callback',resource:origin+'/mcp'});
  const token=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:tokenBody.toString()});
  expect(token.status,await token.clone().text()).toBe(200);const tokens=await token.json() as any;
  const other = new Miniflare({ modules:[{type:'ESModule',path:'worker.mjs',contents:bundledWorker}],compatibilityDate:'2026-05-22',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],d1Databases:['DB'],bindings:{BETTER_AUTH_URL:'https://other.example'} });
  try {expect((await other.dispatchFetch('https://other.example/mcp',{headers:{authorization:'Bearer '+tokens.access_token}})).status).toBe(401);} finally {await other.dispose();}
  const call=await fetch('/mcp',{headers:{authorization:'Bearer '+tokens.access_token}});expect(call.status,await call.clone().text()).toBe(200);
  const liveRefresh=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token,resource:origin+'/mcp'}).toString()});
  expect(liveRefresh.status,await liveRefresh.clone().text()).toBe(200);
  const refreshed=await liveRefresh.json() as any; tokens.refresh_token=refreshed.refresh_token;
  expect((await fetch('/mcp',{headers:{authorization:'Bearer '+refreshed.access_token}})).status).toBe(200);
  const connections=await fetch('/api/mcp/connections',{headers:{cookie}});const record=(await connections.json() as any).connections[0];
  const db=await runtime.getD1Database('DB');await db.prepare('UPDATE access_principals SET disabled_at = 1 WHERE id = ?').bind(record.principalId).run();
  expect((await fetch('/mcp',{headers:{authorization:'Bearer '+tokens.access_token}})).status).toBe(401);
  const refresh=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token,resource:origin+'/mcp'}).toString()});
  expect(refresh.status,await refresh.clone().text()).toBe(400);
  expect((await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:tokenBody.toString()})).status).toBe(400);
 },30000);
 it('concurrent redemption follows provider replay policy without widening the D1 grant',async()=>{
  const verifier='runtime-pkce-verifier-at-least-forty-three-characters';
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  const challenge=Buffer.from(digest).toString('base64url');
  const query=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:'https://client.example/callback',scope:'inbox-angel',resource:origin+'/mcp',state:'opaque-state',code_challenge:challenge,code_challenge_method:'S256'});
  const page=await fetch('/oauth/authorize?'+query,{headers:{cookie}});
  const html=await page.text();expect(page.status,html).toBe(200);expect(html).not.toContain(proof);expect(html).not.toContain('runtime-test-password');
  const handle=html.match(/name="handle" value="([^"]+)"/)?.[1];expect(handle).toBeTruthy();
  const consentCookie=cookie+'; '+cookieOf(page as unknown as Response);
  const form=new URLSearchParams({handle:handle!,workspaceId:'ws_default',domain:'example.com',actions:'reports:read',days:'7'});
  const approved=await fetch('/oauth/authorize',{method:'POST',headers:{cookie:consentCookie,origin,'content-type':'application/x-www-form-urlencoded'},body:form.toString()});
  expect(approved.status,await approved.clone().text()).toBe(302);
  const redirect=new URL(approved.headers.get('location')!);expect(redirect.searchParams.get('iss')).toBe(origin);
  const code=redirect.searchParams.get('code')!;
  const tokenBody=new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:verifier,redirect_uri:'https://client.example/callback',resource:origin+'/mcp'});
  const responses = new Set<object>();
  const redemptions=await Promise.all([0,1].map(async()=>{
   const response=await fetch('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:tokenBody.toString()});
   // Read each independently owned HTTP body as soon as it arrives, before
   // waiting on the competing redemption. Retain values, never live streams.
   expect(responses.has(response), 'redemptions have distinct HTTP responses').toBe(false);
   responses.add(response);
   expect(response.bodyUsed, 'redemption response body is initially unread').toBe(false);
   return {status:response.status,data:await response.json()};
  }));
  expect(redemptions.some(r=>r.status===200)).toBe(true);
  expect(redemptions.every(r=>r.status===200||r.status===400)).toBe(true);
  const issued=redemptions.filter(r=>r.status===200).map(r=>r.data) as any[];
  const principals=new Set<string>();
  for (const tokens of issued) {
   const result=await fetch('/mcp',{headers:{authorization:'Bearer '+tokens.access_token}});
   // A detected replay revokes the provider grant, including already issued tokens.
   if (redemptions.some(r=>r.status===400)) expect(result.status).toBe(401);
   else {expect(result.status).toBe(200);principals.add((await result.json() as any).principalId);}
  }
  expect(principals.size).toBeLessThanOrEqual(1);
 },30000);

});
