import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { forWorkspace } from '@inbox-angel/db';
import { createResolver } from '@inbox-angel/dns-checks';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { makeTenant } from '../helpers/tenant';
import { createInboxMcpHandler } from '../../src/mcp/transport';
import type { McpIdentity } from '../../src/auth/mcp-issuer';
import type { ToolContext } from '../../src/mcp/context';
import { ACCESS_ACTIONS } from '../../src/access/grant';
export async function toolWorld() {
 const tenant = makeTenant({ env: { BETTER_AUTH_URL: 'https://ia.example.com' }, settings: { reportsDomain: undefined } });
 const scope = forWorkspace(tenant.db, tenant.workspaceId);
 await scope.access.principals.create({ id: 'service-agent', name: 'service', kind: 'service' });
 const grantId = 'service-grant';
 await scope.access.grants.create({ id: grantId, principal_id: 'service-agent', workspace_id: tenant.workspaceId, domain: 'example.com', actions: JSON.stringify(ACCESS_ACTIONS.filter(a => a !== 'access:manage')), expires_at: Math.floor(Date.now()/1000)+3600 });
 const identity: McpIdentity = { principalId: 'service-agent', issuer: 'https://ia.example.com', resource: 'https://ia.example.com/mcp' };
 const reportOptions = { resolver: createResolver({ fetch: dohFetch({}) }), resolvers: [createResolver({ fetch: dohFetch({}) }), createResolver({ fetch: dohFetch({}) })], now: 1792954800 };
 const context: ToolContext = { env: tenant.env, identity, reportOptions };
 const handler = createInboxMcpHandler({ reportOptions });
 async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(identity.resource), { fetch: async (url, init) => handler.fetch(new Request(url, init), tenant.env, { props: identity, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext & { props: McpIdentity }) });
  const client = new Client({ name: 'Inbox Angel headless acceptance', version: '1.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  return client;
 }
 return { tenant, scope, context, connect, grantId };
}
