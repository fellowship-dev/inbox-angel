// Resolves the domain record from a DMARC policy domain.
//
// Reports are routed by the policy_domain field in the report XML, not by
// the recipient address — this allows a fixed rua address like
// rua@reports.yourdomain.com to serve all domains.
//
// Returns null if the domain is unknown (not provisioned in D1).

import type { TenantContext } from '../tenancy/context';
import { Domain } from '../db/types';

/**
 * Looks up domain from a DMARC policy domain name.
 * Returns null if the domain is not registered.
 */
export async function resolveDomain(
  tenant: TenantContext,
  policyDomain: string,
): Promise<Domain | null> {
  return (await tenant.scope.domains.getByName(policyDomain.toLowerCase())) as Domain | null;
}
