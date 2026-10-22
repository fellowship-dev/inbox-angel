// Resolves the domain record from a DMARC policy domain.
//
// Reports are routed by the policy_domain field in the report XML, not by
// the recipient address — this allows a fixed rua address like
// rua@reports.yourdomain.com to serve all domains.
//
// Returns null if the domain is unknown (not provisioned in D1).

import { scope } from '../db/scope';
import { Domain } from '../db/types';

/**
 * Looks up domain from a DMARC policy domain name.
 * Returns null if the domain is not registered.
 */
export async function resolveDomain(
  db: D1Database,
  policyDomain: string,
): Promise<Domain | null> {
  return (await scope(db).domains.getByName(policyDomain.toLowerCase())) as Domain | null;
}
