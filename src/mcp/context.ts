import type { BoundEnv } from '../index';
import type { McpIdentity } from '../auth/mcp-issuer';
import { resolveMcpIdentity } from '../auth/mcp-issuer';
import { authorizeResource } from '../access/resolve';
import type { AccessAction, AccessResource } from '../access/grant';
import { loadTenant } from '../tenancy/load';
import { ToolError } from './errors';
import type { ReportOptions } from '../reports/service';
export interface ToolContext { env: BoundEnv; identity: McpIdentity; reportOptions?: ReportOptions }
export async function freshSubject(context: ToolContext) {
 const subject = await resolveMcpIdentity(context.env, context.identity);
 if (!subject) throw new ToolError('forbidden', 'Connection revoked or expired');
 return subject;
}
export async function resourceContext(context: ToolContext, input: { workspaceId?: string; productId?: string; domain?: string }, action: AccessAction) {
 const subject = await freshSubject(context);
 const workspaces = [...new Set(subject.grants.map(g => g.workspaceId))];
 const workspaceId = input.workspaceId ?? (workspaces.length === 1 ? workspaces[0] : undefined);
 if (!workspaceId) throw new ToolError('invalid_input', 'Specify a consented workspaceId for this portfolio');
 const resource: AccessResource = { workspaceId, ...(input.productId ? { productId: input.productId } : {}), ...(input.domain ? { domain: input.domain } : {}) };
 await authorizeResource(context.env.DB, subject, action, resource);
 const tenant = await loadTenant(context.env, { workspaceId, access: subject, userId: subject.userId });
 return { subject, resource, tenant };
}
