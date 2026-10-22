// Cloudflare DNS provisioning for DMARC authorization records.
//
// RFC 7489 §7.1: when the rua= address is on a different domain than the
// policy domain, the reporting domain MUST publish a DNS TXT record to
// authorize receipt of reports:
//
//   {policy-domain}._report._dmarc.{reports-domain}  TXT  "v=DMARC1;"
//
// Example: adding acme.com, reports domain is reports.inboxangel.io
//   → create: acme.com._report._dmarc.reports.inboxangel.io  TXT  "v=DMARC1;"
//
// We manage this record via Cloudflare DNS API. The CF record ID is stored in
// domains.dns_record_id so we can delete it when the domain is removed.

import type { TenantContext } from '../tenancy/context';
import { CfNetworkError, CfNotConfiguredError, CfZoneNotFoundError, cfErrorText, type CfClient } from '../tenancy/cf-client';
import { logAudit } from '../audit/log';

/** Optional audit context — pass to enable self-logging of DNS mutations. */
export interface DnsAuditOpts {
  actor_id?: string | null;
  actor_email?: string | null;
  actor_type?: 'user' | 'system';
  ctx?: ExecutionContext;
}

export class DnsProvisionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DnsProvisionError';
  }
}

export interface DnsProvisionResult {
  recordId: string | null;  // Cloudflare DNS record ID (null in manual mode)
  recordName: string;       // Full DNS name that was created
  manual: boolean;          // true = CF creds absent, user must add DNS record manually
}

/**
 * Creates the cross-domain DMARC authorization TXT record for a monitored domain.
 * Call this when a domain is added. The record lives under the *reports* domain, so it is
 * written to the reports domain's zone, not the monitored domain's.
 */
export async function provisionDomain(
  tenant: TenantContext,
  policyDomain: string,
  audit?: DnsAuditOpts,
): Promise<DnsProvisionResult> {
  const reportsDomain = tenant.settings.reportsDomain;
  // RFC 7489 §7.1 cross-domain authorization record name
  const recordName = `${policyDomain}._report._dmarc.${reportsDomain}`;

  if (!tenant.hasCloudflare() || !reportsDomain) {
    // Manual mode — caller must add the DNS record themselves
    return { recordId: null, recordName, manual: true };
  }

  let cf: CfClient;
  let zoneId: string;
  try {
    cf = await tenant.cfFor(reportsDomain);
    zoneId = (await cf.zoneFor(reportsDomain)).id;
  } catch (e) {
    // The token's account has no zone for the reports domain (or the domain is not linked to a connection): the user adds the record by hand.
    if (e instanceof CfZoneNotFoundError || e instanceof CfNotConfiguredError) return { recordId: null, recordName, manual: true };
    throw new DnsProvisionError(`DNS provision failed: ${cfErrorText(e)}`, e);
  }

  let record;
  try {
    record = await cf.createDnsRecord(zoneId, {
      type: 'TXT',
      name: recordName,
      content: 'v=DMARC1;',
      ttl: 3600,
      comment: `InboxAngel DMARC auth for ${policyDomain}`,
    });
  } catch (e) {
    if (e instanceof CfNetworkError) throw new DnsProvisionError(`DNS provision fetch failed: ${e.message}`, e);
    throw new DnsProvisionError(`Cloudflare rejected DNS record creation: ${cfErrorText(e)}`, e);
  }
  if (!record?.id) throw new DnsProvisionError('Cloudflare rejected DNS record creation: unknown error');

  if (audit) {
    logAudit(tenant, {
      actor_id: audit.actor_id,
      actor_email: audit.actor_email,
      actor_type: audit.actor_type ?? 'user',
      action: 'dns.create',
      resource_type: 'dns_record',
      resource_id: record.id,
      resource_name: recordName,
      after_value: { type: 'TXT', name: recordName, content: 'v=DMARC1;', ttl: 3600 },
    }, audit.ctx);
  }

  return { recordId: record.id, recordName, manual: false };
}

/**
 * Deletes the cross-domain DMARC authorization record.
 * Call this when a domain is removed. Idempotent — 404 is silently ignored.
 */
export async function deprovisionDomain(
  tenant: TenantContext,
  recordId: string,
  audit?: DnsAuditOpts,
): Promise<void> {
  const reportsDomain = tenant.settings.reportsDomain;

  // If CF creds aren't configured, there's nothing to clean up
  if (!tenant.hasCloudflare() || !reportsDomain) return;

  try {
    const cf = await tenant.cfFor(reportsDomain);
    const zone = await cf.zoneFor(reportsDomain);
    await cf.deleteDnsRecord(zone.id, recordId);
  } catch (e) {
    // Domain delete must still succeed: warn and move on.
    console.warn(`deprovisionDomain: could not delete record ${recordId}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (audit) {
    logAudit(tenant, {
      actor_id: audit.actor_id,
      actor_email: audit.actor_email,
      actor_type: audit.actor_type ?? 'user',
      action: 'dns.delete',
      resource_type: 'dns_record',
      resource_id: recordId,
      before_value: { record_id: recordId },
    }, audit.ctx);
  }
}
