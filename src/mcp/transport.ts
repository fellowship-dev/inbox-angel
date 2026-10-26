import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpHandler } from '../auth/mcp-issuer';
import { resolveMcpIdentity } from '../auth/mcp-issuer';
import { mcpInstallation } from './discovery';
import { createInboxMcpServer } from './server';
import type { ReportOptions } from '../reports/service';
export function createInboxMcpHandler(options: { reportOptions?: ReportOptions } = {}): McpHandler {
 return { async fetch(request, env, ctx) {
  const local = mcpInstallation(env);
  const origin = request.headers.get('Origin');
  if (new URL(request.url).origin !== local.issuer || (origin && origin !== local.issuer)) return Response.json({ error: 'Invalid origin' }, { status: 403 });
  if (!await resolveMcpIdentity(env, ctx.props)) return Response.json({ error: 'invalid_token' }, { status: 401 });
  // Fresh server and authorization context per HTTP exchange; SDK owns modern and legacy wire semantics.
  const handler = createMcpHandler(() => createInboxMcpServer({ env, identity: ctx.props, reportOptions: options.reportOptions }), { legacy: 'stateless' });
  return handler.fetch(request);
 } };
}
