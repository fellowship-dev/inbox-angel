// Connecting a domain's DMARC reports on the hosted service (MODE=saas, SAAS_ENABLED=1, INTAKE_DOMAIN set).
//
// Every customer publishes the same fixed address, `rua@<INTAKE_DOMAIN>` (src/hosted/fixed-address.ts). Nothing is
// issued: connecting is the workspace saying "file this domain's reports here", recorded by setting the domain's
// `rua_address` to that address. The intake then files a report about the domain (or one of its subdomains) into the
// one workspace that proved ownership of it and connected it; anything else is refused. Disconnecting clears the
// address, and the intake refuses the domain's reports from then on.
//
// A domain whose reports arrive through hosted records keeps its token address (`rua+<token>@…`), managed by
// src/hosted/service.ts; this module reports that and changes nothing.
//
// Who: owners and admins (the router's member read-only rule refuses every write to members). What: a domain row only,
// so never a pending or lost claim (those live in domain_claims), never an evicted row, and never a row whose
// ownership was not proven ('legacy', from before ownership checks).

import { createResolver, lookupDmarc, planReportAddress, type InheritedPlan, type ReportAddressPlan, type Resolver } from '@inbox-angel/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { hostedConfig, hostedEnabled } from './config';
import { fixedReportAddress, isFixedReportAddress } from './fixed-address';
import { hashToken, intakeAddress, isTokenShaped, parseRecipient } from './tokens';

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
 * not_connected: reports are not connected. not_published: connected, but the live DMARC record does not list the
 * address. waiting: listed, no report stored yet. receiving: at least one report is stored. unknown: connected, the
 * DNS lookup failed and no report is stored, so nothing can be said about the record.
 */
export type ReportAddressState = 'not_connected' | 'not_published' | 'waiting' | 'receiving' | 'unknown';

export interface ReportAddressView {
  /** Report intake is configured on this deployment (MODE=saas, SAAS_ENABLED=1, INTAKE_DOMAIN). */
  available: true;
  domain_id: number;
  domain: string;
  /** Hosted records publish this domain's address; this API leaves it alone. */
  managed_by: 'hosted_records' | null;
  /** Whether an owner or admin may connect this domain's reports, and if not, why. */
  can_connect: boolean;
  refusal: string | null;
  /** The address to publish: the fixed hosted address (or a token address given earlier), once connected. */
  address: string | null;
  /** When the newest report for this domain was stored. */
  last_report_at: number | null;
  state: ReportAddressState;
  /** The live DMARC check, made only when connected. `plan` is null when the lookup failed. */
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

/**
 * The domain's connected address: the fixed one, or a token address whose token is still the domain's current one
 * (an address given out before the fixed address existed keeps working). Anything else counts as not connected.
 */
async function connectedAddress(tenant: TenantContext, domain: DomainRow, intakeDomain: string): Promise<string | null> {
  if (isFixedReportAddress(domain.rua_address, intakeDomain)) return fixedReportAddress(intakeDomain);
  const rcpt = parseRecipient(domain.rua_address?.trim() ?? '');
  if (!rcpt || rcpt.base !== 'rua' || rcpt.host !== intakeDomain || !rcpt.tag || !isTokenShaped(rcpt.tag)) return null;
  const token = await tenant.scope.intake.get(domain.id);
  return token && (await hashToken(rcpt.tag)) === token.token_hash ? intakeAddress('rua', rcpt.tag, intakeDomain) : null;
}

export async function reportAddressStatus(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}): Promise<ReportIntakeStatus> {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain) return { available: false };
  const managed_by = (await tenant.scope.hosted.get(domain.id)) ? 'hosted_records' as const : null;
  const address = managed_by ? null : await connectedAddress(tenant, domain, intakeDomain);
  const refusal = managed_by ? 'Reports for this domain come through its hosted records.' : refusalFor(domain);

  let last_report_at: number | null = null;
  let dns: ReportAddressView['dns'] = null;
  if (address) {
    last_report_at = await tenant.scope.intake.lastReportAt(domain.id);
    const lookup = await lookupDmarc(deps.resolver ?? createResolver(), domain.domain);
    const checked_at = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    dns = { checked_at, error: lookup.status === 'error' ? (lookup.error ?? 'DNS lookup failed') : null, plan: planReportAddress(lookup, address) };
  }

  let state: ReportAddressState = 'not_connected';
  if (address) {
    if (last_report_at !== null) state = 'receiving';
    else if (!dns?.plan) state = 'unknown';
    else state = dns.plan.kind === 'published' ? 'waiting' : 'not_published';
  }

  return { available: true, domain_id: domain.id, domain: domain.domain, managed_by, can_connect: !refusal, refusal, address, last_report_at, state, dns };
}

function requireIntake(tenant: TenantContext): string {
  const intakeDomain = reportIntakeDomain(tenant.env);
  if (!intakeDomain) throw new ReportAddressError('Report intake is not enabled on this server', 404);
  return intakeDomain;
}

async function assertNotHosted(tenant: TenantContext, domain: DomainRow): Promise<void> {
  if (await tenant.scope.hosted.get(domain.id)) throw new ReportAddressError('Reports for this domain come through its hosted records. Manage them there.', 409);
}

function audit(tenant: TenantContext, domain: DomainRow, action: string, actor: Actor | undefined, ctx: ExecutionContext | undefined) {
  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action, resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
  }, ctx);
}

/** Connect: file this domain's reports here. Already connected: nothing changes and the status comes back (`created: false`). */
export async function connectReports(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<{ created: boolean; status: ReportIntakeStatus }> {
  const intakeDomain = requireIntake(tenant);
  await assertNotHosted(tenant, domain);
  const refusal = refusalFor(domain);
  if (refusal) throw new ReportAddressError(refusal, 403);
  if (await connectedAddress(tenant, domain, intakeDomain)) return { created: false, status: await reportAddressStatus(tenant, domain, deps) };
  await tenant.scope.intake.setAddress(domain.id, fixedReportAddress(intakeDomain));
  audit(tenant, domain, 'reports.connect', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return { created: true, status: await reportAddressStatus(tenant, fresh, deps) };
}

/** Disconnect at once: the intake refuses this domain's reports from now on (a token address, if any, stops too). Stored reports stay. */
export async function disconnectReports(tenant: TenantContext, domain: DomainRow, deps: ReportAddressDeps = {}, actor?: Actor, ctx?: ExecutionContext): Promise<ReportIntakeStatus> {
  requireIntake(tenant);
  await assertNotHosted(tenant, domain);
  await tenant.scope.intake.disconnect(domain.id);
  audit(tenant, domain, 'reports.disconnect', actor, ctx);
  const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
  return reportAddressStatus(tenant, fresh, deps);
}
