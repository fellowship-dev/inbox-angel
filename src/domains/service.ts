import { claimLookups, type DomainRow } from '@inbox-angel/db';
import { authorizeResource } from '../access/resolve';
import type { TenantContext } from '../tenancy/context';
import { admitDomain, claimView, settleClaims, type VerifiedVia } from './ownership';
import { logAudit } from '../audit/log';
import { track } from '../telemetry';
import { lookupSpf, lookupDmarc } from '../email/dns-check';

export class DomainServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface EnrollmentOptions { productId?: string }

/** Delegated enrollment cannot authorize the legacy transfer's DNS writes or owner email. */
export async function assertAgentEnrollmentSafe(tenant: TenantContext, domain: string): Promise<void> {
  if (tenant.access && !tenant.access.session && await claimLookups(tenant.db).findLegacyHolder(domain, tenant.workspaceId)) {
    throw new DomainServiceError('legacy domain transfer requires a signed-in operator', 409);
  }
}

async function authorizeProductEnrollment(tenant: TenantContext, domain: string, options: EnrollmentOptions): Promise<void> {
  if (options.productId === undefined) return;
  if (!tenant.access || !options.productId) throw new DomainServiceError('explicit product enrollment authority required', 403);
  await authorizeResource(tenant.db, tenant.access, 'domains:manage', { workspaceId: tenant.workspaceId, productId: options.productId, domain });
  if (!await tenant.scope.access.products.get(options.productId)) throw new DomainServiceError('product not authorized', 403);
}

async function assertExistingProductMapping(tenant: TenantContext, domain: DomainRow, options: EnrollmentOptions): Promise<void> {
  if (options.productId !== undefined && !(await tenant.scope.access.products.mappings(options.productId)).some(m => m.domain_id === domain.id)) {
    throw new DomainServiceError('existing domain requires an owner-approved product mapping', 403);
  }
}

export function enrollmentView(domain: DomainRow, reportsDomain?: string) {
  const ready = !!reportsDomain;
  const rua = ready ? `rua@${reportsDomain}` : null;
  const auth = ready ? `${domain.domain}._report._dmarc.${reportsDomain}` : null;
  return {
    domain,
    intake: ready ? { status: 'configured' as const, address: rua } : { status: 'unavailable' as const, reason: 'not_configured' as const },
    rua_hint: rua ? `Add rua=mailto:${rua} to your DMARC record` : null,
    auth_record: auth,
    dns_instructions: auth ? `Add this TXT record to authorize DMARC reports:\n  ${auth}  TXT  "v=DMARC1;"` : null,
  };
}

/** Proof and monitoring are independent of the optional report intake hub. No DNS writes. */
export async function enrollDomain(tenant: TenantContext, input: string, userEmail?: string, ctx?: ExecutionContext, actorId?: string, options: EnrollmentOptions = {}) {
  const domain = input.toLowerCase().trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new DomainServiceError('invalid domain format', 400);
  await authorizeProductEnrollment(tenant, domain, options);
  await assertAgentEnrollmentSafe(tenant, domain);
  const existing = await tenant.scope.domains.getByName(domain);
  if (existing) await assertExistingProductMapping(tenant, existing, options);
  const admission = await admitDomain(tenant, domain);
  if (admission.kind === 'taken') throw new DomainServiceError('domain already registered in another workspace', 409);
  if (admission.kind === 'limit') throw new DomainServiceError('too many unverified domains — verify or remove some first', 429);
  if (admission.kind === 'pending') return { pending: true as const, claim: claimView(admission.claim), domain: null };
  return commitVerifiedDomain(tenant, domain, admission.via, userEmail, ctx, actorId, options);
}

/** Inserts a domain whose ownership is established, with the side effects of adding one. */
export async function commitVerifiedDomain(tenant: TenantContext, domain: string, via: VerifiedVia, userEmail?: string, ctx?: ExecutionContext, actorId?: string, options: EnrollmentOptions = {}) {
  await authorizeProductEnrollment(tenant, domain, options);
  await assertAgentEnrollmentSafe(tenant, domain);
  const rdomain = tenant.settings.reportsDomain;
  const existing = await tenant.scope.domains.getByName(domain);
  if (existing) {
    await assertExistingProductMapping(tenant, existing, options);
    return { ...enrollmentView(existing, rdomain), resumed: true };
  }

  // Fixed rua address — routing is by XML policy_domain, not by address encoding
  const ruaAddress = rdomain ? `rua@${rdomain}` : '';

  // Insert domain row — no DNS writes here; all DNS changes require explicit user action
  let domainId: number;
  try {
    const result = await tenant.scope.domains.insert({ domain, rua_address: ruaAddress, verified_via: via }, options.productId);
    domainId = result.meta.last_row_id as number;
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) {
      // Concurrent replay may have won the insert; only resume a row in this workspace.
      const raced = await tenant.scope.domains.getByName(domain);
      if (raced) {
        await assertExistingProductMapping(tenant, raced, options);
        return { ...enrollmentView(raced, rdomain), resumed: true };
      }
      throw new DomainServiceError('domain already registered in another workspace', 409);
    }
    throw e;
  }
  await settleClaims(tenant, domain);

  track(tenant, { event: 'domain.add' }); // fire-and-forget, non-blocking

  logAudit(tenant, {
    actor_id: actorId ?? null, actor_email: userEmail ?? null, actor_type: 'user',
    action: 'domain.add',
    resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
    after_value: { domain, rua_address: ruaAddress },
  }, ctx);

  // Auto-subscribe the adding user to monitoring alerts
  const email = userEmail;
  if (email) {
    await tenant.scope.monitor.insert({
      email: email.toLowerCase().trim(),
      domain,
      session_token: null,
      confirmed_at: Math.floor(Date.now() / 1000), // a signed-in account holder adding their own domain: no confirmation needed
      spf_record: null,
      dmarc_policy: null,
      dmarc_pct: null,
      dmarc_record: null,
    }).catch(e => console.warn('[domain.add] monitor sub insert failed (non-fatal):', e));
  }

  // Background SPF lookup — fire-and-forget, doesn't block response
  if (ctx) {
    ctx.waitUntil(
      lookupSpf(domain)
        .then(spf => {
          if (spf?.lookup_count !== undefined) {
            return tenant.scope.domains.updateSpfLookupCount(domainId, spf.lookup_count);
          }
        })
        .catch(e => console.warn('[domain.add] background SPF walk failed (non-fatal):', e))
    );
  }

  // Return the full domain row so the frontend has the ID
  const domainRow = await tenant.scope.domains.getById(domainId);

  // If subdomain, fetch parent context for the inheritance-aware wizard
  let parent_context: { domain: string; dmarc_policy: string | null; dmarc_sp: string | null; has_dmarc: boolean } | null = null;
  if (domainRow?.parent_id) {
    const parentRow = await tenant.scope.domains.getById(domainRow.parent_id);
    if (parentRow) {
      // A failed lookup leaves parent_context unset: "unknown" must not be reported as "parent has no DMARC".
      const parentDmarc = await lookupDmarc(parentRow.domain).then(r => ({ ok: true as const, r }), () => ({ ok: false as const, r: null }));
      if (parentDmarc.ok) {
        const pd = parentDmarc.r;
        parent_context = {
          domain: parentRow.domain,
          dmarc_policy: pd?.policy ?? null,
          // sp= tag: null means not explicitly set (frontend distinguishes sp=none vs absent)
          dmarc_sp: pd ? (pd.subdomainPolicy ?? null) : null,
          has_dmarc: pd !== null,
        };
      }
    }
  }

  return {
    ...enrollmentView(domainRow!, rdomain), resumed: false,
    ...(parent_context !== null ? { parent_context } : {}),
  };
}

