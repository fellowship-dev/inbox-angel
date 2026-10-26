import { z } from 'zod';
export const selector = z.object({ workspaceId: z.string().min(1).optional(), productId: z.string().min(1).optional() }).strict();
export const hostname = z.string().min(3).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Use a lowercase DNS hostname without a URL or port');
export const domainInput = selector.extend({ domain: hostname });
export const reportInput = domainInput.extend({ days: z.number().int().min(1).max(90).optional() });
export const metricsInput = reportInput.extend({ source: z.enum(['dmarc', 'tls', 'google', 'inbox_placement']).optional() });
export const outputSchema = z.object({
 schema: z.literal('inbox-angel-tool/v1'), summary: z.string(),
 data: z.record(z.string(), z.unknown()), evidence: z.array(z.object({ href: z.string(), label: z.string() })),
 error: z.object({ code: z.enum(['forbidden', 'invalid_input', 'not_found', 'unavailable']), message: z.string() }).optional(),
});
export type DomainInput = z.infer<typeof reportInput>;
// Named result fields are stable; nested shared report fields remain additive across catalog releases.
const resource = z.object({ workspaceId: z.string(), productId: z.string().optional(), domain: z.string().optional() });
const coverage = z.object({ scope: z.literal('shared-domain'), product_attribution: z.literal(false), detail: z.string() });
const report = z.object({ schema: z.literal('inbox-angel-health/v1'), domain: z.object({ id: z.number(), domain: z.string() }), generatedAt: z.string(), coverage, dns: z.record(z.string(),z.unknown()), analytics: z.record(z.string(),z.unknown()), sections: z.record(z.string(),z.unknown()), remediation: z.array(z.record(z.string(),z.unknown())), intake: z.record(z.string(),z.unknown()) });
export const toolOutputs = Object.freeze({
 whoami: outputSchema.extend({ data: z.object({ installation: z.string(), principalId: z.string(), kind: z.enum(['human','service']), grants: z.array(z.object({ workspaceId: z.string(), productId: z.string().optional(), domain: z.string().optional(), actions: z.array(z.string()), expiresAt: z.number() })) }) }),
 list_products: outputSchema.extend({ data: z.object({ products: z.array(z.object({id:z.string(),name:z.string(),workspaceId:z.string(),coverage:z.literal('shared-domain')})) }) }),
 list_domains: outputSchema.extend({ data: z.object({ domains: z.array(z.object({id:z.number(),domain:z.string(),workspaceId:z.string(),productId:z.string().optional(),coverage:z.literal('shared-domain'),mappedProductIds:z.array(z.string())})) }) }),
 inspect_domain: outputSchema.extend({data:z.object({dns:z.record(z.string(),z.unknown())})}),
 add_domain: outputSchema.extend({data:z.object({enrollment:z.record(z.string(),z.unknown())})}),
 verify_domain: outputSchema.extend({data:z.object({verified:z.boolean().optional(),enrollment:z.record(z.string(),z.unknown()).optional(),reason:z.string().optional(),claim:z.record(z.string(),z.unknown()).optional()})}),
 get_email_report: outputSchema.extend({data:z.object({resource,report})}),
 query_email_metrics: outputSchema.extend({data:z.object({resource,coverage,domain:z.object({id:z.number(),domain:z.string()}),sections:z.record(z.string(),z.unknown())})}),
 plan_remediation: outputSchema.extend({data:z.object({resource,coverage,domain:z.object({id:z.number(),domain:z.string()}),fixes:z.array(z.record(z.string(),z.unknown()))})}),
 get_source_status: outputSchema.extend({data:z.object({resource,intake:z.record(z.string(),z.unknown()),sources:z.record(z.string(),z.object({status:z.string(),reason:z.string().optional()})),connect:z.object({google:z.string(),instruction:z.string()})})}),
});
