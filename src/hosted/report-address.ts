// A domain's report address without hosted records (MODE=saas, SAAS_ENABLED=1, INTAKE_DOMAIN set).
//
// Issuing gives a verified domain its own `rua+<token>@<INTAKE_DOMAIN>`; the customer adds it to the DMARC record they
// already publish. Unlike hosted records this needs no records zone, no records token and no CNAMEs. The token is the
// same kind (160 random bits, src/hosted/tokens.ts) in the same table (intake_tokens: only its SHA-256), so the inbound
// side (src/hosted/intake.ts) and its isolation are unchanged: a token resolves to one workspace and one domain, and only
// reports for that domain or its subdomains are filed.
//
// The address is also kept in clear in `domains.rua_address`. That reveals nothing new: in this mode the customer
// publishes it in their DMARC TXT record, which anyone can read. It lets the dashboard show the address again and the
// live check compare it; the stored hash stays the only thing intake trusts.
//
// Who: owners and admins (the router's member read-only rule refuses every write to members). What: a domain row only,
// so never a pending or lost claim (those live in domain_claims), never an evicted row, and never a row whose
// ownership was not proven ('legacy', from before ownership checks).

import { createResolver, lookupDmarc, planReportAddress, type InheritedPlan, type ReportAddressPlan, type Resolver } from '@inbox-angel/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { hostedConfig, hostedEnabled } from './config';
import { generateToken, hashToken, intakeAddress, isTokenShaped, parseRecipient } from './tokens';

export class ReportAddressError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ReportAddressError';
  }
}

export interface ReportAddressDeps {
  resolver?: Resolver;
  now?: () => number;
}

type DomainRow = NonNullable<Awaited<ReturnType<TenantContext['scope']['domains']['getById']>>>;
type Actor = { id?: string | null; email?: string | null };

/**
 * not_issued: no address yet. not_published: issued, but the live DMARC record does not list it. waiting: listed, no
 * report has arrived since. receiving: at least one report has arrived. unknown: issued, the DNS lookup failed, and no
 * report has arrived, so nothing can be said about the record.
 */
export type ReportAddressState = 'not_issued' | 'not_published' | 'waiting' | 'receiving' | 'unknown';

export interface ReportAddressView {
  /** Report intake is configured on this deployment (MODE=saas, SAAS_ENABLED=1, INTAKE_DOMAIN). */
  available: true;
  domain_id: number;
  domain: string;
  /** Hosted records publish this domain's address; this API leaves it alone. */
  managed_by: 'hosted_records' | null;
  /** Whether an owner or admin may issue an address for this domain, and if not, why. */
  can_issue: boolean;
  refusal: string | null;
  address: string | null;
  issued_at: number | null;
  rotated_at: number | null;
  /** After a rotation: the previous address keeps working until then (Unix seconds). */
  previous_valid_until: number | null;
  /** When the newest report arrived for this domain since the address was first issued. */
  last_report_at: number | null;
  state: ReportAddressState;
  /** The live DMARC check, made only when an address exists. `plan` is null when the lookup failed. */
  dns: { checked_at: number; error: string | null; plan: ReportAddressPlan | InheritedPlan | null } | null;
}

export type ReportIntakeStatus = { available: false } | ReportAddressView;

/** The intake domain when report intake is on, else null. Independent of the free check and of hosted records. */
export function reportIntakeDomain(env: TenantContext['env']): string | null {
  if (!hostedEnabled(env)) return null;
  return hostedConfig(env).intakeDomain ?? null;
}

const refusalFor = (domain: DomainRow): string | null =>
  domain.verified_via === 'legacy'
    ? `${domain.domain} was added before ownership checks. Remove it and add it again to prove that you control it, then connect reports.`
    : null;

/** The domain's stored address, if it is one of ours and matches the current token (anything else counts as no address). */
async function currentAddress(domain: DomainRow, tokenHash: string | null, intakeDomain: string): Promise<string | null> {
  if (!tokenHash) return null;
  const rcpt = parseRecipient(domain.rua_address?.trim() ?? '');
  if (!rcpt || rcpt.base !== 'rua' || rcpt.host !== intakeDomain || !rcpt.tag || !isTokenShaped(rcpt.tag)) return null;
  return (await hashToken(rcpt.tag)) === tokenHash ? intakeAddress('rua', rcpt.tag, intakeDomain) : null;
}

export async function reportAddressStatus(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}): Promise<ReportIntakeStatus> {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain) return { available: false };
  const [hosted, token] = await Promise.all([tenant.scope.hosted.get(domain.id), tenant.scope.intake.get(domain.id)]);
  const managed_by = hosted ? 'hosted_records' as const : null;
  const address = managed_by ? null : await currentAddress(domain, token?.token_hash ?? null, intakeDomain);
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const refusal = managed_by ? 'Reports for this domain come through its hosted records.' : refusalFor(domain);

  let last_report_at: number | null = null;
  let dns: ReportAddressView['dns'] = null;
  if (address && token) {
    last_report_at = await tenant.scope.intake.lastReportSince(domain.id, token.created_at);
    const lookup = await lookupDmarc(deps.resolver ?? createResolver(), domain.domain);
    dns = { checked_at: nowS, error: lookup.status === 'error' ? (lookup.error ?? 'DNS lookup failed') : null, plan: planReportAddress(lookup, address) };
  }

  let state: ReportAddressState = 'not_issued';
  if (address) {
    if (last_report_at !== null) state = 'receiving';
    else if (!dns?.plan) state = 'unknown';
    else state = dns.plan.kind === 'published' ? 'waiting' : 'not_published';
  }

  const graceLeft = token?.prev_expires_at && token.prev_expires_at > nowS ? token.prev_expires_at : null;
  return {
    available: true,
    domain_id: domain.id,
    domain: domain.domain,
    managed_by,
    can_issue: !refusal,
    refusal,
    address,
    issued_at: address ? token?.created_at ?? null : null,
    rotated_at: address ? token?.rotated_at ?? null : null,
    previous_valid_until: address ? graceLeft : null,
    last_report_at,
    state,
    dns,
  };
}

function requireIntake(tenant: TenantContext): string {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain) throw new ReportAddressError('Report intake is not enabled on this server', 404);
  return intakeDomain;
}

async function assertMayIssue(tenant: TenantContext, domain: DomainRow): Promise<void> {
  if (await tenant.scope.hosted.get(domain.id)) throw new ReportAddressError('Reports for this domain come through its hosted records. Manage the address there.', 409);
  const refusal = refusalFor(domain);
  if (refusal) throw new ReportAddressError(refusal, 403);
}

async function writeNewAddress(tenant: TenantContext, domain: DomainRow, intakeDomain: string, deps: ReportAddressDeps): Promise<void> {
  const token = generateToken();
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  await tenant.scope.intake.issueAddress(domain.id, await hashToken(token), intakeAddress('rua', token, intakeDomain), nowS);
}

function audit(tenant: TenantContext, domain: DomainRow, action: string, actor: Actor | undefined, ctx: ExecutionContext | undefined) {
  // The address is public in this mode, but the audit trail does not need it: the domain and the action say what happened.
  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action, resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
  }, ctx);
}

/** Issue the domain's address. Already issued: nothing changes and the current status comes back (`created: false`). */
export async function issueReportAddress(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<{ created: boolean; status: ReportIntakeStatus }> {
  const intakeDomain = requireIntake(tenant);
  await assertMayIssue(tenant, domain);
  const token = await tenant.scope.intake.get(domain.id);
  if (await currentAddress(domain, token?.token_hash ?? null, intakeDomain)) {
    return { created: false, status: await reportAddressStatus(tenant, domain, deps) };
  }
  await writeNewAddress(tenant, domain, intakeDomain, deps);
  audit(tenant, domain, 'report_address.issue', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return { created: true, status: await reportAddressStatus(tenant, fresh, deps) };
}

/** A new address; the previous one keeps working for the grace period (TOKEN_ROTATION_GRACE_SECONDS), then stops. */
export async function rotateReportAddress(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<ReportIntakeStatus> {
  const intakeDomain = requireIntake(tenant);
  await assertMayIssue(tenant, domain);
  const token = await tenant.scope.intake.get(domain.id);
  if (!(await currentAddress(domain, token?.token_hash ?? null, intakeDomain))) throw new ReportAddressError('This domain has no report address to replace. Connect reports first.', 409);
  await writeNewAddress(tenant, domain, intakeDomain, deps);
  audit(tenant, domain, 'report_address.rotate', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return reportAddressStatus(tenant, fresh, deps);
}

/** Revoke at once: the current and any previous address stop working now. Reports already stored stay. */
export async function revokeReportAddress(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<ReportIntakeStatus> {
  requireIntake(tenant);
  if (await tenant.scope.hosted.get(domain.id)) throw new ReportAddressError('Reports for this domain come through its hosted records. Manage the address there.', 409);
  await tenant.scope.intake.revokeAddress(domain.id);
  audit(tenant, domain, 'report_address.revoke', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return reportAddressStatus(tenant, fresh, deps);
}
