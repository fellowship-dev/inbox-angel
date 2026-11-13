// Real workerd + the Workers rate-limit bindings: /mcp is limited per connection (MCP_LIMITER) and per workspace
// (API_LIMITER), answers 429 with Retry-After, one agent at its limit does not lock out another agent of the same
// workspace, and registration, token and anonymous requests are limited per IP (AUTH_LIMITER).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
let runtime: Miniflare;
const origin = 'https://ia.example.com';
const CONNECTION = 3, WORKSPACE = 5, ANONYMOUS = 2;
const keys = { a: 'ias_rate_limit_agent_a_random_material', a2: 'ias_rate_limit_agent_a2_random_material', b: 'ias_rate_limit_agent_b_random_material' };
beforeAll(async () => {
 const source = `
import { coreWorker } from './src/index.ts';
import { withMcpAuthorization } from './src/auth/mcp-issuer.ts';
import { createInboxMcpHandler } from './src/mcp/transport.ts';
export default withMcpAuthorization(coreWorker, createInboxMcpHandler());`;
 const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'runtime-rate-limit.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], write: false });
 runtime = new Miniflare({
  modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundled.outputFiles[0].text }],
  compatibilityDate: '2026-05-22', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'], d1Databases: ['DB'], bindings: { BETTER_AUTH_URL: origin },
  ratelimits: { MCP_LIMITER: { simple: { limit: CONNECTION, period: 60 } }, API_LIMITER: { simple: { limit: WORKSPACE, period: 60 } }, AUTH_LIMITER: { simple: { limit: ANONYMOUS, period: 60 } } },
 });
 const db = await runtime.getD1Database('DB');
 await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)').run();
 for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
  for (const statement of (await readFile(resolve('migrations', name), 'utf8')).replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) await db.prepare(statement).run();
  await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name).run();
 }
 await db.prepare("INSERT INTO workspaces(id,name) VALUES ('ws_other','Other client')").run();
 const expires = Math.floor(Date.now() / 1000) + 3600;
 for (const [agent, workspace, key] of [['agent-a', 'ws_default', keys.a], ['agent-a2', 'ws_default', keys.a2], ['agent-b', 'ws_other', keys.b]] as const) {
  await db.prepare("INSERT INTO access_principals(id,workspace_id,name,kind) VALUES (?,?,?,'service')").bind(agent, workspace, agent).run();
  await db.prepare('INSERT INTO access_grants(id,workspace_id,principal_id,domain,actions,expires_at) VALUES (?,?,?,?,?,?)').bind(`grant-${agent}`, workspace, agent, 'example.com', JSON.stringify(['resources:read']), expires).run();
  await db.prepare('INSERT INTO access_credentials(id,workspace_id,principal_id,name,key_hash,prefix,expires_at) VALUES (?,?,?,?,?,?,?)').bind(`key-${agent}`, workspace, agent, agent, createHash('sha256').update(key).digest('hex'), key.slice(0, 11), expires).run();
 }
}, 30000);
afterAll(async () => { await runtime?.dispose(); });

const ping = (key: string) => runtime.dispatchFetch(`${origin}/mcp`, {
 method: 'POST',
 headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': '198.51.100.7', 'mcp-protocol-version': '2025-11-25' },
 body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
});

const anonymous = (path: string, ip: string, init: RequestInit = {}) => runtime.dispatchFetch(`${origin}${path}`, { method: 'POST', ...init, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(init.headers as Record<string, string> ?? {}) }, body: init.body ?? '{}' });

describe('/mcp rate limits in the Workers runtime', () => {
 it(`allows ${CONNECTION} requests a minute per connection, then answers 429 with Retry-After`, async () => {
  for (let i = 0; i < CONNECTION; i++) {
   const ok = await ping(keys.a);
   expect(ok.status, await ok.clone().text()).toBe(200);
   await ok.arrayBuffer();
  }
  const limited = await ping(keys.a);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  expect(await limited.json()).toMatchObject({ error: 'rate_limited', error_description: expect.stringMatching(/^This agent connection/) });
 });

 it('a second agent in the same workspace, from the same address, is not starved by the first', async () => {
  const other = await ping(keys.a2);
  expect(other.status, await other.clone().text()).toBe(200);
  await other.arrayBuffer();
  // ...until the workspace as a whole reaches its own, higher limit (3 from agent-a + 2 from agent-a2).
  expect((await ping(keys.a2)).status).toBe(200);
  const full = await ping(keys.a2);
  expect(full.status).toBe(429);
  expect(await full.json()).toMatchObject({ error_description: expect.stringMatching(/^Agents connected to this workspace/) });
 });

 it('another workspace has its own budget', async () => {
  const other = await ping(keys.b);
  expect(other.status, await other.clone().text()).toBe(200);
 });

 it(`limits /mcp without a token, a bad token, /oauth/register and /oauth/token to ${ANONYMOUS} a minute per IP`, async () => {
  expect((await anonymous('/mcp', '203.0.113.1')).status).toBe(401);
  expect((await anonymous('/mcp', '203.0.113.1', { headers: { authorization: 'Bearer not-a-real-token' } })).status).toBe(401);
  const limited = await anonymous('/mcp', '203.0.113.1');
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  expect((await anonymous('/oauth/register', '203.0.113.2')).status).not.toBe(429);
  expect((await anonymous('/oauth/token', '203.0.113.2')).status).not.toBe(429);
  expect((await anonymous('/oauth/register', '203.0.113.2')).status).toBe(429);
  // Authenticated agents are never counted per IP: the limited address still works with a valid token.
  const valid = await runtime.dispatchFetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${keys.b}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': '203.0.113.1', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  expect(valid.status).toBe(200);
 });
});
