import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { globalQueries } from '@inbox-angel/db';
import { DNS_CHECK_LIMITS, limitAnonymousAgentRequest, limitBrowserRequest, limitMcpRequest, MCP_REQUEST_LIMITS, MCP_REQUEST_WINDOW_SECONDS, RateLimitedError, spendDnsCheck } from '../../src/mcp/rate-limit';
import { toolFailure } from '../../src/mcp/errors';
import type { AccessSubject } from '../../src/access/principal';
import { connection } from './helpers';
import type { TestDb } from '../auth/helpers';
import { toolWorld } from './tool-fixture';

/** A stand-in for the API_LIMITER binding that records every key it is asked about. */
function limiter(deny: (key: string) => boolean = () => false) {
 const keys: string[] = [];
 return { keys, binding: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !deny(key) }; } } };
}
const subject = { principalId: 'agent-1', kind: 'human', workspaceId: 'ws_a', grants: [{ workspaceId: 'ws_a' }, { workspaceId: 'ws_b' }, { workspaceId: 'ws_a' }] } as unknown as AccessSubject;

describe('/mcp request limit: per connection and per workspace, never per IP', () => {
 const both = (connection = limiter(), workspace = limiter()) => ({ env: { MCP_LIMITER: connection.binding, API_LIMITER: workspace.binding }, connection, workspace });

 it('counts once for the connection (MCP_LIMITER) and once for each granted workspace (API_LIMITER)', async () => {
  const { env, connection, workspace } = both();
  expect(await limitMcpRequest(env, subject)).toBeNull();
  expect(connection.keys).toEqual(['mcp:connection:agent-1']);
  expect(workspace.keys).toEqual(['mcp:workspace:ws_a', 'mcp:workspace:ws_b']);
 });

 it('the per-connection limit is lower than the workspace limit, in wrangler.jsonc as in the code', () => {
  const bindings = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config.unsafe.bindings as Array<{ name: string; simple: { limit: number; period: number } }>;
  const limit = (name: string) => bindings.find(b => b.name === name)!.simple;
  expect(limit('MCP_LIMITER')).toEqual({ limit: MCP_REQUEST_LIMITS.perConnection, period: 60 });
  expect(limit('API_LIMITER')).toEqual({ limit: MCP_REQUEST_LIMITS.perWorkspace, period: 60 });
  expect(MCP_REQUEST_LIMITS.perConnection).toBeLessThan(MCP_REQUEST_LIMITS.perWorkspace);
 });

 it('answers 429 with Retry-After when the connection is over its limit, without spending workspace budget', async () => {
  const { env, workspace } = both(limiter(() => true));
  const res = (await limitMcpRequest(env, subject))!;
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe(String(MCP_REQUEST_WINDOW_SECONDS));
  expect(await res.json()).toEqual({ error: 'rate_limited', error_description: 'This agent connection sent too many requests. Wait 60 seconds and try again.' });
  expect(workspace.keys).toEqual([]);
 });

 it('answers 429 when any workspace the connection reaches is over its limit', async () => {
  const { env } = both(limiter(), limiter(k => k === 'mcp:workspace:ws_b'));
  const res = (await limitMcpRequest(env, subject))!;
  expect(res.status).toBe(429);
  expect((await res.json() as { error_description: string }).error_description).toMatch(/^Agents connected to this workspace/);
 });

 it('self-host without bindings runs unlimited; the hosted service refuses with 503 instead', async () => {
  expect(await limitMcpRequest({}, subject)).toBeNull();
  for (const env of [{ MODE: 'saas' }, { MODE: 'saas', API_LIMITER: limiter().binding }, { MODE: 'saas', MCP_LIMITER: limiter().binding }]) {
   const res = (await limitMcpRequest(env, subject))!;
   expect(res.status).toBe(503);
   expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
  }
  expect(await limitMcpRequest({ MODE: 'saas', ...both().env }, subject)).toBeNull();
 });

 it('keeps consent and connection pages on the dashboard\'s per-IP key', async () => {
  const l = limiter(k => k === '203.0.113.9');
  expect(await limitBrowserRequest({ API_LIMITER: l.binding }, new Request('https://ia.example.com/oauth/authorize', { headers: { 'cf-connecting-ip': '198.51.100.1' } }))).toBeNull();
  const res = (await limitBrowserRequest({ API_LIMITER: l.binding }, new Request('https://ia.example.com/oauth/authorize', { headers: { 'cf-connecting-ip': '203.0.113.9' } })))!;
  expect(res.status).toBe(429);
  expect(l.keys).toEqual(['198.51.100.1', '203.0.113.9']);
 });

 it('limits registration, token and anonymous agent requests per IP with AUTH_LIMITER', async () => {
  const l = limiter(k => k === 'oauth:203.0.113.9');
  expect(await limitAnonymousAgentRequest({ AUTH_LIMITER: l.binding }, new Request('https://ia.example.com/oauth/token', { headers: { 'cf-connecting-ip': '198.51.100.1' } }))).toBeNull();
  const res = (await limitAnonymousAgentRequest({ AUTH_LIMITER: l.binding }, new Request('https://ia.example.com/oauth/token', { headers: { 'cf-connecting-ip': '203.0.113.9' } })))!;
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  expect(l.keys).toEqual(['oauth:198.51.100.1', 'oauth:203.0.113.9']);
 });
});

describe('live DNS check budget (the expensive tools)', () => {
 it(`allows ${DNS_CHECK_LIMITS.perConnection} checks per connection per minute, then a rate_limited tool error with a retry time`, async () => {
  const { env } = await connection();
  for (let i = 0; i < DNS_CHECK_LIMITS.perConnection; i++) await spendDnsCheck(env, 'agent', 'ws_default');
  const error = await spendDnsCheck(env, 'agent', 'ws_default').catch(e => e);
  expect(error).toBeInstanceOf(RateLimitedError);
  const failure = toolFailure(error);
  expect(failure.isError).toBe(true);
  expect(failure.structuredContent.error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: expect.any(Number) });
  expect(failure.structuredContent.error.message).toMatch(/^This agent connection ran 10 live DNS checks within one minute, the limit\. Try again in \d+ seconds\.$/);
 });

 it(`caps a workspace at ${DNS_CHECK_LIMITS.perWorkspace} checks per minute across its connections`, async () => {
  const { env } = await connection();
  for (const principal of ['a', 'b', 'c']) for (let i = 0; i < DNS_CHECK_LIMITS.perConnection; i++) await spendDnsCheck(env, principal, 'ws_default');
  const error = await spendDnsCheck(env, 'd', 'ws_default').catch(e => e);
  expect(error).toBeInstanceOf(RateLimitedError);
  expect(error.message).toMatch(/^Agents in this workspace ran 30 live DNS checks/);
  // Another workspace has its own budget.
  await expect(spendDnsCheck(env, 'd', 'ws_other')).resolves.toBeUndefined();
 });

 it('a refusal by the workspace limit does not spend the connection\'s count', async () => {
  const { env } = await connection();
  const now = 1_800_000_000_000;
  for (const principal of ['a', 'b', 'c']) for (let i = 0; i < DNS_CHECK_LIMITS.perConnection; i++) await spendDnsCheck(env, principal, 'ws_default', { now, prune: false });
  await expect(spendDnsCheck(env, 'd', 'ws_default', { now, prune: false })).rejects.toBeInstanceOf(RateLimitedError);
  const q = globalQueries(env.DB).rateLimit;
  expect(await q.peek('mcp-dns:connection:d', now, 60_000)).toBeNull();
  expect((await q.peek('mcp-dns:workspace:ws_default', now, 60_000))!.count).toBe(DNS_CHECK_LIMITS.perWorkspace);
  // And d still has its full budget elsewhere.
  for (let i = 0; i < DNS_CHECK_LIMITS.perConnection; i++) await spendDnsCheck(env, 'd', 'ws_other', { now, prune: false });
 });

 it('deletes expired live-check counter rows as checks run, and leaves other limiters\' rows alone', async () => {
  const { env } = await connection();
  const q = globalQueries(env.DB).rateLimit;
  const t0 = 1_800_000_000_000;
  await spendDnsCheck(env, 'old', 'ws_old', { now: t0, prune: false });
  await q.hit('login:198.51.100.1', t0, 60_000);
  const count = async () => (env.DB as unknown as TestDb).sqlite.prepare("SELECT key FROM auth_rate_limits ORDER BY key").all().map((r: any) => r.key);
  expect(await count()).toEqual(['login:198.51.100.1', 'mcp-dns:connection:old', 'mcp-dns:workspace:ws_old']);
  await spendDnsCheck(env, 'new', 'ws_new', { now: t0 + 61_000, prune: true });
  expect(await count()).toEqual(['login:198.51.100.1', 'mcp-dns:connection:new', 'mcp-dns:workspace:ws_new']);
 });

 it('through the real MCP server: the 11th report in a minute is refused; tools without DNS checks keep working', async () => {
  const world = await toolWorld();
  const client = await world.connect();
  expect((await client.callTool({ name: 'add_domain', arguments: { domain: 'example.com' } })).isError).not.toBe(true);
  for (let i = 0; i < DNS_CHECK_LIMITS.perConnection; i++) {
   const tool = ['get_email_report', 'inspect_domain', 'plan_remediation', 'query_email_metrics', 'get_source_status'][i % 5];
   const ok = await client.callTool({ name: tool, arguments: { domain: 'example.com' } });
   expect(ok.isError, JSON.stringify(ok.structuredContent)).not.toBe(true);
  }
  const refused = await client.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent).toMatchObject({ error: { code: 'rate_limited', retryAfterSeconds: expect.any(Number) } });
  expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).not.toBe(true);
  expect((await client.callTool({ name: 'list_domains', arguments: {} })).isError).not.toBe(true);
  await client.close();
 });

 it('an unknown domain does not spend the budget', async () => {
  const world = await toolWorld();
  const client = await world.connect();
  for (let i = 0; i < DNS_CHECK_LIMITS.perConnection + 2; i++) {
   const missing = await client.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } });
   expect(missing.structuredContent).toMatchObject({ error: { code: 'not_found' } });
  }
  // Still not limited: the budget was never spent.
  expect((await client.callTool({ name: 'add_domain', arguments: { domain: 'example.com' } })).isError).not.toBe(true);
  expect((await client.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } })).isError).not.toBe(true);
  await client.close();
 });
});
