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

import { createResolver, lookupDmarc, planReportAddress, type InheritedPlan, type ReportAddressPlan, type Resolver } from '@ready-set-mail/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { reportVisibility, type ReportVisibility } from '../reports/visibility';
import { hostedConfig, hostedEnabled } from './config';
import { fixedReportAddress, isFixedReportAddress, workspaceMayConnectReports } from './fixed-address';
import { isDomainProven } from '../domains/ownership';
import type { BoundEnv } from '../index';
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
 * address. waiting: listed, no COUNTED report since connecting. receiving: listed AND at least one COUNTED report (an authenticated
 * registry reporter, reporter_tier 'counted') stored since connecting. unknown: connected, but the DNS lookup failed, so nothing can
 * be said about the record. Uncounted reports never make a domain "received"; they are counted apart and named.
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
  /** When the current connection began (null for an older token address). */
  connected_at: number | null;
  /** The newest COUNTED report stored since the connection began; how many counted, and all reports (counted or not), since then; reports before it apart. */
  last_report_at: number | null;
  counted_since_connect: number;
  reports_since_connect: number;
  reports_before_connect: number;
  /** What the dashboard must say besides the state (uncounted and not-stored reports), over the reports since connecting (src/reports/visibility.ts). */
  visibility: ReportVisibility | null;
  state: ReportAddressState;
  /** The live DMARC check, made only when connected. `plan` is null when the lookup failed. */
  dns: { checked_at: number; error: string | null; plan: ReportAddressPlan | InheritedPlan | null } | null;
  /** When the domain follows its organizational domain's record: that domain, if this workspace has it, and whether its reports are connected. */
  parent: { domain_id: number; domain: string; connected: boolean } | null;
}

export type ReportIntakeStatus = { available: false } | ReportAddressView;

/** The intake domain when report intake is on, else null. Independent of the free check and of hosted records. */
export function reportIntakeDomain(env: TenantContext['env']): string | null {
  if (!hostedEnabled(env)) return null;
  return hostedConfig(env).intakeDomain ?? null;
}

/** Why this domain's reports cannot be connected, or null. Hosted records are handled by the callers. */
async function refusalFor(tenant: TenantContext, domain: DomainRow): Promise<string | null> {
  if (domain.verified_via === 'legacy') return `Ownership of ${domain.domain} is not proven in this workspace. Remove it and add it again to prove that you control it, then connect reports.`;
  if (!(await isDomainProven(tenant, domain))) return `${domain.domain} was added through a parent domain that is no longer in this workspace. Remove it and add it again to prove that you control it, then connect reports.`;
  if (!(await workspaceMayConnectReports(tenant.env as BoundEnv, tenant.workspaceId))) return 'On this server, only the operator\'s workspaces can connect reports.';
  return null;
}

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
  const refusal = managed_by ? 'Reports for this domain come through its hosted records.' : await refusalFor(tenant, domain);
  // A refused domain (unproven, or a workspace HOSTED_CONNECT_REPORTS does not admit) receives nothing: not connected,
  // whatever its stored address says.
  const address = managed_by || refusal ? null : await connectedAddress(tenant, domain, intakeDomain);
  const connected_at = address ? domain.reports_connected_at ?? null : null;

  let counts = { since: 0, counted_since: 0, last_counted_since: null as number | null, before: 0 };
  let dns: ReportAddressView['dns'] = null;
  let visibility: ReportVisibility | null = null;
  if (address) {
    counts = await tenant.scope.intake.reportsAround(domain.id, connected_at);
    // Since the connection began, by when we RECEIVED the reports: a report covers the previous day, so its period starts before the connection.
    visibility = await reportVisibility(tenant, domain.id, connected_at ?? 0, undefined, 'received');
    const lookup = await lookupDmarc(deps.resolver ?? createResolver(), domain.domain);
    const checked_at = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    dns = { checked_at, error: lookup.status === 'error' ? (lookup.error ?? 'DNS lookup failed') : null, plan: planReportAddress(lookup, address) };
  }
  let parent: ReportAddressView['parent'] = null;
  if (dns?.plan?.kind === 'inherited') {
    const row = await tenant.scope.domains.getByName(dns.plan.from);
    if (row) parent = { domain_id: row.id, domain: row.domain, connected: !!(await connectedAddress(tenant, row, intakeDomain)) };
  }

  // Evidence only: received means published in live DNS AND a COUNTED report stored since this connection began.
  let state: ReportAddressState = 'not_connected';
  if (address) {
    if (!dns?.plan) state = 'unknown';
    else if (dns.plan.kind !== 'published') state = 'not_published';
    else state = counts.counted_since > 0 ? 'receiving' : 'waiting';
  }

  return {
    available: true, domain_id: domain.id, domain: domain.domain, managed_by, can_connect: !refusal, refusal, address,
    connected_at, last_report_at: counts.last_counted_since, counted_since_connect: counts.counted_since, reports_since_connect: counts.since,
    reports_before_connect: counts.before, visibility, state, dns, parent,
  };
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
  const refusal = await refusalFor(tenant, domain);
  if (refusal) throw new ReportAddressError(refusal, 403);
  if (await connectedAddress(tenant, domain, intakeDomain)) return { created: false, status: await reportAddressStatus(tenant, domain, deps) };
  await tenant.scope.intake.connect(domain.id, fixedReportAddress(intakeDomain), Math.floor((deps.now?.() ?? Date.now()) / 1000));
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
