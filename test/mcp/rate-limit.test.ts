import { describe, expect, it } from 'vitest';
import { DNS_CHECK_LIMITS, limitBrowserRequest, limitMcpRequest, MCP_REQUEST_WINDOW_SECONDS, RateLimitedError, spendDnsCheck } from '../../src/mcp/rate-limit';
import { toolFailure } from '../../src/mcp/errors';
import type { AccessSubject } from '../../src/access/principal';
import { connection } from './helpers';
import { toolWorld } from './tool-fixture';

/** A stand-in for the API_LIMITER binding that records every key it is asked about. */
function limiter(deny: (key: string) => boolean = () => false) {
 const keys: string[] = [];
 return { keys, binding: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !deny(key) }; } } };
}
const subject = { principalId: 'agent-1', kind: 'human', workspaceId: 'ws_a', grants: [{ workspaceId: 'ws_a' }, { workspaceId: 'ws_b' }, { workspaceId: 'ws_a' }] } as unknown as AccessSubject;

describe('/mcp request limit: per connection and per workspace, never per IP', () => {
 it('lets a request through and counts it once for the connection and once for each granted workspace', async () => {
  const l = limiter();
  expect(await limitMcpRequest({ API_LIMITER: l.binding }, subject)).toBeNull();
  expect(l.keys).toEqual(['mcp:connection:agent-1', 'mcp:workspace:ws_a', 'mcp:workspace:ws_b']);
 });

 it('answers 429 with Retry-After when the connection is over its limit, without spending workspace budget', async () => {
  const l = limiter(k => k.startsWith('mcp:connection:'));
  const res = (await limitMcpRequest({ API_LIMITER: l.binding }, subject))!;
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe(String(MCP_REQUEST_WINDOW_SECONDS));
  expect(await res.json()).toEqual({ error: 'rate_limited', error_description: 'This agent connection sent too many requests. Wait 60 seconds and try again.' });
  expect(l.keys).toEqual(['mcp:connection:agent-1']);
 });

 it('answers 429 when any workspace the connection reaches is over its limit', async () => {
  const res = (await limitMcpRequest({ API_LIMITER: limiter(k => k === 'mcp:workspace:ws_b').binding }, subject))!;
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  expect((await res.json() as { error_description: string }).error_description).toMatch(/^Agents connected to this workspace/);
 });

 it('does nothing when the binding is absent (tests, installs without it)', async () => {
  expect(await limitMcpRequest({}, subject)).toBeNull();
 });

 it('keeps consent and connection pages on the dashboard\'s per-IP key', async () => {
  const l = limiter(k => k === '203.0.113.9');
  const ok = await limitBrowserRequest({ API_LIMITER: l.binding }, new Request('https://ia.example.com/oauth/authorize', { headers: { 'cf-connecting-ip': '198.51.100.1' } }));
  expect(ok).toBeNull();
  const res = (await limitBrowserRequest({ API_LIMITER: l.binding }, new Request('https://ia.example.com/oauth/authorize', { headers: { 'cf-connecting-ip': '203.0.113.9' } })))!;
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  expect(l.keys).toEqual(['198.51.100.1', '203.0.113.9']);
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
