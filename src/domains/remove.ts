// The resource cleanup of taking a domain out of service: its hosted records (and their quota in the shared zone) and its
// report-authorisation DNS record. Shared by DELETE /api/domains/:id and by the eviction of an unproven holder.
import { disableHosted } from '../hosted/service';
import { hostedEnabled } from '../hosted/config';
import { deprovisionDomain } from '../dns/provision';
import { logAudit } from '../audit/log';
import type { TenantContext } from '../tenancy/context';
import type { DomainRow } from '@inbox-angel/db';

export type Actor = { id?: string | null; email?: string | null };

/** Remove the hosted records of a domain, if it has any. Throws HostedError when the DNS cleanup fails. */
export async function removeHostedRecords(tenant: TenantContext, domain: DomainRow, actor?: Actor, ctx?: ExecutionContext): Promise<boolean> {
  if (!(hostedEnabled(tenant.env) && (await tenant.scope.hosted.get(domain.id)))) return false;
  await disableHosted(tenant, domain, {}, actor && { id: actor.id ?? undefined, email: actor.email ?? undefined }, ctx);
  return true;
}

/** Best-effort removal of the report-authorisation DNS record (non-fatal if it fails), with its audit entry. */
export async function removeAuthRecord(tenant: TenantContext, domain: DomainRow, actor?: Actor, ctx?: ExecutionContext): Promise<void> {
  if (!domain.dns_record_id) return;
  const rdomain = tenant.settings.reportsDomain;
  const recordName = rdomain ? `${domain.domain}._report._dmarc.${rdomain}` : domain.dns_record_id;
  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: actor ? 'user' : 'system',
    action: 'dns.delete',
    resource_type: 'dns_record', resource_id: domain.dns_record_id, resource_name: recordName,
    before_value: { type: 'TXT', name: recordName, content: 'v=DMARC1;', ttl: 3600 },
  }, ctx);
  await deprovisionDomain(tenant, domain.dns_record_id).catch(e => console.warn(`deprovisionDomain failed for domain ${domain.id}:`, e));
}
