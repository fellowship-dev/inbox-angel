// Real workerd + the Workers rate-limit binding: /mcp is limited per connection and per workspace, answers 429 with
// Retry-After, and one agent's burst does not lock out a connection in another workspace from the same address.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
let runtime: Miniflare;
const origin = 'https://ia.example.com';
const LIMIT = 4;
const keys = { a: 'ias_rate_limit_agent_a_random_material', b: 'ias_rate_limit_agent_b_random_material' };
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
  ratelimits: { API_LIMITER: { simple: { limit: LIMIT, period: 60 } } },
 });
 const db = await runtime.getD1Database('DB');
 await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)').run();
 for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
  for (const statement of (await readFile(resolve('migrations', name), 'utf8')).replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) await db.prepare(statement).run();
  await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name).run();
 }
 await db.prepare("INSERT INTO workspaces(id,name) VALUES ('ws_other','Other client')").run();
 const expires = Math.floor(Date.now() / 1000) + 3600;
 for (const [agent, workspace, key] of [['agent-a', 'ws_default', keys.a], ['agent-b', 'ws_other', keys.b]] as const) {
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

describe('/mcp rate limit in the Workers runtime', () => {
 it(`allows ${LIMIT} requests a minute per connection, then answers 429 with Retry-After`, async () => {
  for (let i = 0; i < LIMIT; i++) {
   const ok = await ping(keys.a);
   expect(ok.status, await ok.clone().text()).not.toBe(429);
   await ok.arrayBuffer();
  }
  const limited = await ping(keys.a);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
 });

 it('another connection in another workspace, from the same address, is not affected', async () => {
  const other = await ping(keys.b);
  expect(other.status, await other.clone().text()).not.toBe(429);
 });

 it('a request without a valid token is refused before it can spend anyone\'s budget', async () => {
  const anonymous = await runtime.dispatchFetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(anonymous.status).toBe(401);
 });
});
