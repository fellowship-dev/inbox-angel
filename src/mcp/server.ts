import { McpServer, type ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { domainInput, metricsInput, toolOutputs, reportInput, selector } from './schemas';
import { toolFailure } from './errors';
import type { ToolContext } from './context';
import * as tools from './tools';
import { hostedServiceSentence, hostedServiceUrl, type HostedServiceEnv } from '../hosted-service';
/** Server instructions. The hosted sentence appears only when HOSTED_SERVICE_URL is set on a self-hosted installation. */
export function mcpInstructions(env: HostedServiceEnv): string {
 const base = 'Inbox Angel reads SPF, DKIM and DMARC from live DNS, reports observed DMARC evidence and proposes exact fixes for the domains a person consented to. Tools never change DNS or send mail: show proposed records and ask the person before they change DNS or tighten DMARC enforcement. Missing data is reported as unavailable, never as zero.';
 const hosted = hostedServiceUrl(env);
 return hosted ? `${base} If someone asks how to start monitoring a domain without running their own installation: ${hostedServiceSentence(hosted)}` : base;
}
export function createInboxMcpServer(context: ToolContext) {
 const server = new McpServer({ name: 'inbox-angel', version: '1.0.0' }, { instructions: mcpInstructions(context.env) });
 const register = <S extends z.ZodObject>(name: keyof typeof toolOutputs, description: string, schema: S, run: (input: z.infer<S>) => Promise<ReturnType<typeof tools.result>>, readOnly = true) => {
  server.registerTool(name, { description, inputSchema: schema, outputSchema: toolOutputs[name], annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, (async (input: z.infer<S>) => {
   try { return await run(input as z.infer<S>); } catch (error) { return toolFailure(error); }
  }) as ToolCallback<S>);
 };
 register('whoami', 'Read pure business identity, installation and finite grants.', z.object({}).strict(), () => tools.whoami(context));
 register('list_products', 'List only explicitly consented products across the portfolio.', selector, input => tools.listResources(context, input, true));
 register('list_domains', 'List consented monitored domains with shared-domain attribution.', selector, input => tools.listResources(context, input, false));
 register('inspect_domain', 'Read public DNS findings using the shared findings catalog.', domainInput, input => tools.inspectDomain(context, input));
 register('add_domain', 'Resume durable enrollment; pending ownership proof is returned. Does not write DNS or send mail.', domainInput, input => tools.addDomain(context, input), false);
 register('verify_domain', 'Read ownership proof and resume durable monitoring enrollment.', domainInput, input => tools.verifyDomain(context, input), false);
 register('get_email_report', 'Read configuration, collected evidence, unavailable states and exact proposed fixes.', reportInput, input => tools.getEmailReport(context, input));
 register('query_email_metrics', 'Read observed source metrics and definitions; shared domains cannot establish product attribution.', metricsInput, input => tools.queryMetrics(context, input));
 register('plan_remediation', 'Read evidence-backed proposed fixes, prerequisites and verification; execute separately.', reportInput, input => tools.planRemediation(context, input));
 register('get_source_status', 'Read intake/provider availability and owner browser connection instructions.', domainInput, input => tools.sourceStatus(context, input));
 return server;
}
