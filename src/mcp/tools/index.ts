import { forWorkspace } from '@inbox-angel/db';
import { checkDomain, createResolver, DOH_ENDPOINTS } from '@inbox-angel/dns-checks';
import { buildReport } from '@inbox-angel/report';
import { authorizeResource, authorizedDomains } from '../../access/resolve';
import { getDomainReport } from '../../reports/service';
import { enrollDomain, commitVerifiedDomain, assertAgentEnrollmentSafe } from '../../domains/service';
import { claimView, verifyClaim } from '../../domains/ownership';
import { mcpInstallation } from '../discovery';
import { freshSubject, resourceContext, type ToolContext } from '../context';
import type { DomainInput } from '../schemas';
import { ToolError } from '../errors';

export function result(summary: string, data: Record<string, unknown>, evidence: { href: string; label: string }[] = []) {
 const structuredContent = { schema: 'inbox-angel-tool/v1' as const, summary, data, evidence };
 return { content: [{ type: 'text' as const, text: summary }], structuredContent };
}
export async function whoami(context: ToolContext) {
 const subject = await freshSubject(context);
 return result('Authenticated Inbox Angel identity and explicit consent.', { installation: mcpInstallation(context.env).resource, principalId: subject.principalId, kind: subject.kind, grants: subject.grants.map(({ workspaceId, productId, domain, actions, expiresAt }) => ({ workspaceId, productId, domain, actions, expiresAt })) });
}
export async function listResources(context: ToolContext, input: { workspaceId?: string; productId?: string }, products: boolean) {
 const subject = await freshSubject(context);
 const scopes = [...new Map(subject.grants.filter(g => g.actions.includes('resources:read') && (!input.workspaceId || g.workspaceId === input.workspaceId) && (!input.productId || g.productId === input.productId)).map(g => [JSON.stringify([g.workspaceId, g.productId]), { workspaceId: g.workspaceId, productId: g.productId }])).values()];
 if ((input.workspaceId || input.productId) && !scopes.length) throw new ToolError('forbidden', 'Resource selection not consented');
 const resources: Record<string, unknown>[] = [];
 const seen = new Set<string>();
 for (const scope of scopes) {
  if (products) {
   const q = forWorkspace(context.env.DB, scope.workspaceId);
   for (const product of await q.access.products.list()) {
    const grants = subject.grants.filter(g => g.workspaceId === scope.workspaceId && g.productId === product.id && g.actions.includes('resources:read'));
    if (!grants.length || (input.productId && input.productId !== product.id)) continue;
    for (const grant of grants) await authorizeResource(context.env.DB, subject, 'resources:read', { workspaceId: grant.workspaceId, productId: grant.productId, domain: grant.domain });
    const key = `${scope.workspaceId}/${product.id}`;
    if (!seen.has(key)) { seen.add(key); resources.push({ id: product.id, name: product.name, workspaceId: scope.workspaceId, coverage: 'shared-domain' }); }
   }
  } else {
   for (const domain of await authorizedDomains(context.env.DB, subject, scope)) {
    await authorizeResource(context.env.DB, subject, 'resources:read', { ...scope, domain: domain.domain });
    const key = `${scope.workspaceId}/${scope.productId ?? ''}/${domain.id}`;
    if (!seen.has(key)) { seen.add(key); resources.push({ id: domain.id, domain: domain.domain, ...scope, coverage: 'shared-domain', mappedProductIds: domain.mappedProductIds }); }
   }
  }
 }
 return result(`${resources.length} authorized ${products ? 'products' : 'domains'}.`, { [products ? 'products' : 'domains']: resources });
}
async function report(context: ToolContext, input: DomainInput, action: 'reports:read' | 'metrics:read' | 'remediation:plan' | 'resources:read') {
 const resolved = await resourceContext(context, input, action);
 const domain = await resolved.tenant.scope.domains.getByName(input.domain);
 if (!domain) throw new ToolError('not_found', 'Domain not enrolled; call add_domain first');
 const data = await getDomainReport(resolved.tenant, domain.id, { ...context.reportOptions, days: input.days ?? context.reportOptions?.days });
 const base = mcpInstallation(context.env).issuer;
 return { data, resource: resolved.resource, evidence: [{ href: `${base}/#/w/${encodeURIComponent(resolved.tenant.workspaceId)}/domains/${domain.id}`, label: 'Private domain evidence report (authorized browser access required)' }] };
}
export async function getEmailReport(context: ToolContext, input: DomainInput) {
 const { data, resource, evidence } = await report(context, input, 'reports:read');
 return result(`Email health for ${input.domain}: ${data.dns.findings.length} configuration findings; domain aggregates are shared-domain coverage. Missing telemetry is explicitly unavailable.`, { resource, report: data }, evidence);
}
export async function queryMetrics(context: ToolContext, input: DomainInput & { source?: 'dmarc' | 'tls' | 'google' | 'inbox_placement' }) {
 const { data, resource, evidence } = await report(context, input, 'metrics:read');
 return result(`Observed email metrics for ${input.domain}; unavailable values are not zero.`, { resource, coverage: data.coverage, domain: data.domain, sections: input.source ? { [input.source]: data.sections[input.source] } : data.sections }, evidence);
}
export async function planRemediation(context: ToolContext, input: DomainInput) {
 const { data, resource, evidence } = await report(context, input, 'remediation:plan');
 return result(`${data.remediation.length} proposed fixes for ${input.domain}. Apply changes separately, then repeat inspection.`, { resource, domain: data.domain, coverage: data.coverage, fixes: data.remediation }, evidence);
}
export async function inspectDomain(context: ToolContext, input: DomainInput) {
 await resourceContext(context, input, 'diagnostics:run');
 const resolvers = context.reportOptions?.resolvers ?? (context.reportOptions?.resolver ? [context.reportOptions.resolver] : [createResolver(), createResolver({ endpoint: DOH_ENDPOINTS.google })]);
 const dns = buildReport({ runs: await Promise.all(resolvers.map(resolver => checkDomain(input.domain, { resolver }))), generatedAt: new Date((context.reportOptions?.now ?? Date.now()/1000)*1000).toISOString() });
 return result(`Public DNS inspection for ${input.domain}: ${dns.findings.length} findings. No changes applied.`, { dns });
}
export async function sourceStatus(context: ToolContext, input: DomainInput) {
 const { data, resource, evidence } = await report(context, input, 'resources:read');
 return result(`Collection status for ${input.domain}.`, { resource, intake: data.intake, sources: Object.fromEntries(Object.entries(data.sections).map(([name, section]) => [name, { status: section.status, reason: 'reason' in section ? section.reason : undefined }])), connect: { google: `${mcpInstallation(context.env).issuer}/#/w/${encodeURIComponent(resource.workspaceId)}/settings`, instruction: 'An owner connects Google Postmaster in browser settings. Provider credentials never enter MCP.' } }, evidence);
}
export async function addDomain(context: ToolContext, input: DomainInput) {
 const { tenant } = await resourceContext(context, input, 'domains:manage');
 await assertAgentEnrollmentSafe(tenant, input.domain);
 const enrollment = await enrollDomain(tenant, input.domain, undefined, undefined, context.identity.principalId, { productId: input.productId });
 return result('Domain enrollment saved; follow the returned ownership proof when pending. No DNS records or messages were changed.', { enrollment });
}
export async function verifyDomain(context: ToolContext, input: DomainInput) {
 const { tenant } = await resourceContext(context, input, 'domains:manage');
 await assertAgentEnrollmentSafe(tenant, input.domain);
 const domain = await tenant.scope.domains.getByName(input.domain);
 if (domain) {
  const enrollment = await enrollDomain(tenant, input.domain, undefined, undefined, context.identity.principalId, { productId: input.productId });
  return result('Domain already enrolled.', { enrollment });
 }
 const claim = await tenant.scope.claims.get(input.domain);
 if (!claim) throw new ToolError('not_found', 'No pending claim; call add_domain first');
 const outcome = await verifyClaim(tenant, claim, context.reportOptions?.resolver);
 if (outcome.kind === 'taken') throw new ToolError('forbidden', 'Domain belongs to another workspace');
 if (outcome.kind === 'unproven') return result('Ownership proof not verified yet.', { verified: false, reason: outcome.reason, claim: claimView((await tenant.scope.claims.get(input.domain)) ?? claim) });
 const enrollment = await commitVerifiedDomain(tenant, input.domain, outcome.via, undefined, undefined, context.identity.principalId, { productId: input.productId });
 return result('Ownership verified and monitoring enrollment saved.', { verified: true, enrollment });
}
