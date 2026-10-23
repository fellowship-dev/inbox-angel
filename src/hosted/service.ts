// Hosted records for one domain: enable, status, rotate the intake token, verify the customer's pointers, disable.
//
// Everything here acts through the caller's TenantContext (workspace-scoped queries) and writes DNS only through
// the hosted-records writer (src/hosted/records.ts). The intake token is shown once, on enable and on rotate:
// only its hash is stored. (It is also published in the hosted DMARC / TLS-RPT records, which is why rotation
// edits those records rather than asking the customer to change anything.)

import { createResolver, type Resolver } from '@inbox-angel/dns-checks';
import { globalQueries, type PointerStatus } from '@inbox-angel/db';
import type { TenantContext } from '../tenancy/context';
import { CfError, CfNotConfiguredError, cfErrorText } from '../tenancy/cf-client';
import { logAudit } from '../audit/log';
import { discoverMxHosts, generatePolicyId } from '../email/mta-sts';
import { hostedApex, hostedConfig, hostedEnabled } from './config';
import { generateHostedId, generateToken, hashToken, intakeAddress } from './tokens';
import {
  buildHostedDmarc, buildHostedTlsRpt, hostedNames, openHostedZone, retargetRua, HostedNameError, type HostedRecordWriter,
} from './records';
import { chooseZone, HostedQuotaError, zoneSlot } from './zones';
import { flattenSource } from './spf';
import { customerPointers, levelInputs, mergePointerReport, verifyPointers } from './pointers';

export class HostedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HostedError';
  }
}

export interface HostedDeps {
  /** Transport for Cloudflare calls (tests). */
  fetch?: typeof fetch;
  /** DNS resolver for SPF flattening and pointer checks (tests). */
  resolver?: Resolver;
  now?: () => number;
}

type DomainRow = NonNullable<Awaited<ReturnType<TenantContext['scope']['domains']['getById']>>>;

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];

function requireHosted(tenant: TenantContext) {
  const env = tenant.env;
  const cfg = hostedConfig(env);
  if (!hostedEnabled(env) || !cfg.intakeDomain || !cfg.recordsZone) throw new HostedError('Hosted records are not enabled on this deployment', 404);
  return { cfg, intakeDomain: cfg.intakeDomain, apex: hostedApex(cfg)! };
}

async function writerFor(tenant: TenantContext, zoneKey: string, deps: HostedDeps): Promise<HostedRecordWriter> {
  const slot = zoneSlot(tenant.env, zoneKey);
  if (!slot) throw new HostedError(`Unknown hosted zone ${zoneKey}`, 500);
  try {
    const writer = await openHostedZone(tenant.env, slot.name, { fetch: deps.fetch });
    await globalQueries(tenant.db).hostedZones.upsert({ zone_key: slot.key, zone_id: writer.zone.id, zone_name: writer.zone.name });
    return writer;
  } catch (e) {
    if (e instanceof CfNotConfiguredError) throw new HostedError('HOSTED_RECORDS_TOKEN is not configured', 500);
    if (e instanceof CfError || e instanceof Error) throw new HostedError(`Hosted zone unavailable: ${cfErrorText(e)}`, 502);
    throw e;
  }
}

export interface HostedView {
  enabled: true;
  hosted_id: string;
  records: { dmarc: string; spf: string; tls_rpt: string; mta_sts: string | null };
  /** What the customer adds to their own DNS. */
  pointers: ReturnType<typeof customerPointers>;
  pointer_status: { dmarc: PointerStatus | null; spf: PointerStatus | null; mta_sts: PointerStatus | null; tls_rpt: PointerStatus | null; checked_at: number | null };
  /** For the domain's Level: a hosted record counts as published once its pointer is in place. */
  level_inputs: ReturnType<typeof levelInputs>;
  mta_sts: boolean;
}

async function view(tenant: TenantContext, domain: DomainRow): Promise<HostedView | null> {
  const h = await tenant.scope.hosted.get(domain.id);
  if (!h) return null;
  const { apex } = requireHosted(tenant);
  const names = hostedNames(h.hosted_id, apex);
  const mtaSts = !!h.mta_sts_txt_record_id;
  const status = { dmarc: h.dmarc_pointer as PointerStatus | null, spf: h.spf_pointer as PointerStatus | null, mta_sts: h.mta_sts_pointer as PointerStatus | null, tls_rpt: h.tls_rpt_pointer as PointerStatus | null };
  return {
    enabled: true,
    hosted_id: h.hosted_id,
    records: { dmarc: names.dmarc, spf: names.spf, tls_rpt: names.tlsRpt, mta_sts: mtaSts ? names.mtaSts : null },
    pointers: customerPointers(domain.domain, h.hosted_id, apex, { mtaSts }),
    pointer_status: { ...status, checked_at: h.pointers_checked_at },
    level_inputs: levelInputs(status),
    mta_sts: mtaSts,
  };
}

export const hostedStatus = view;

export interface EnableOptions {
  /** The SPF record to flatten into the hosted record. Default: what the domain publishes today. */
  spfRecord?: string;
  /** Also host the MTA-STS records (testing mode, the domain's current MX hosts). */
  mtaSts?: boolean;
}

export interface Addresses { rua: string; tls_rpt: string }

export async function enableHosted(
  tenant: TenantContext,
  domain: DomainRow,
  opts: EnableOptions = {},
  deps: HostedDeps = {},
  actor?: { id?: string | null; email?: string | null },
  ctx?: ExecutionContext,
): Promise<{ hosted: HostedView; addresses: Addresses }> {
  const { intakeDomain, apex } = requireHosted(tenant);
  if (await tenant.scope.hosted.get(domain.id)) throw new HostedError('Hosted records are already enabled for this domain', 409);
  const resolver = deps.resolver ?? createResolver();

  // The SPF the hosted record is built from: given, or what the domain publishes now.
  let source = opts.spfRecord?.trim();
  if (!source) {
    const txt = await resolver.txt(domain.domain);
    if (txt.status === 'error') throw new HostedError(`Could not read the SPF record of ${domain.domain}: ${txt.error ?? 'DNS error'}`, 502);
    const spf = txt.records.filter(r => /^v=spf1(\s|$)/i.test(r.trim()));
    if (spf.length > 1) throw new HostedError(`${domain.domain} publishes more than one SPF record; fix that first or pass spf_record`, 422);
    source = spf[0]?.trim() ?? 'v=spf1 ~all';
  }
  if (!/^v=spf1(\s|$)/i.test(source)) throw new HostedError('spf_record must start with v=spf1', 400);
  const flat = await flattenSource(domain.domain, source, resolver);
  if (!flat.ok) throw new HostedError(`Could not fully resolve the SPF record: ${flat.errors.map(e => e.message).join('; ')}`, 422);
  const spfContent = flat.content;

  let mxHosts: string[] = [];
  if (opts.mtaSts) {
    mxHosts = await discoverMxHosts(domain.domain).catch(e => { throw new HostedError(e instanceof Error ? e.message : 'MX lookup failed', 502); });
    if (mxHosts.length === 0) throw new HostedError(`No MX records found for ${domain.domain}; MTA-STS needs a mail server to name`, 422);
  }

  const needed = opts.mtaSts ? 5 : 3;
  let slot;
  try {
    ({ slot } = await chooseZone(tenant.env, needed));
  } catch (e) {
    if (e instanceof HostedQuotaError) throw new HostedError(e.message, 507);
    throw e;
  }
  const writer = await writerFor(tenant, slot.key, deps);

  const hostedId = generateHostedId();
  const token = generateToken();
  const names = hostedNames(hostedId, apex);
  const policy = POLICIES.includes(domain.dmarc_policy ?? '') ? domain.dmarc_policy as 'none' | 'quarantine' | 'reject' : 'none';
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);

  await tenant.scope.hosted.insert({ domain_id: domain.id, hosted_id: hostedId, zone_key: slot.key, spf_source: source });
  await tenant.scope.intake.set(domain.id, await hashToken(token), now);

  const created: Array<{ id: string; name: string }> = [];
  const zones = globalQueries(tenant.db).hostedZones;
  const write = async (type: string, name: string, content: string, extra: { proxied?: boolean; ttl?: number } = {}) => {
    const rec = await writer.create({ type, name, content, ttl: extra.ttl ?? 300, proxied: extra.proxied, comment: 'InboxAngel hosted record' });
    created.push({ id: rec.id, name });
    await zones.addCount(slot.key, 1);
    return rec.id;
  };
  try {
    const ids = {
      dmarc_record_id: await write('TXT', names.dmarc, buildHostedDmarc(policy, token, intakeDomain)),
      spf_record_id: await write('TXT', names.spf, spfContent),
      tls_rpt_record_id: await write('TXT', names.tlsRpt, buildHostedTlsRpt(token, intakeDomain)),
      mta_sts_txt_record_id: null as string | null,
      mta_sts_host_record_id: null as string | null,
    };
    if (opts.mtaSts) {
      const policyId = generatePolicyId(new Date(now * 1000));
      ids.mta_sts_txt_record_id = await write('TXT', names.mtaSts, `v=STSv1; id=${policyId}`);
      // The Worker serves the policy at this host; 100:: is the usual placeholder origin for a proxied name.
      ids.mta_sts_host_record_id = await write('AAAA', names.mtaSts, '100::', { proxied: true, ttl: 1 });
      await tenant.scope.mtaSts.insert({
        domain_id: domain.id, mode: 'testing', mx_hosts: mxHosts.join(','), policy_id: policyId,
        mta_sts_record_id: ids.mta_sts_txt_record_id, tls_rpt_record_id: ids.tls_rpt_record_id, cname_record_id: ids.mta_sts_host_record_id,
      });
    }
    await tenant.scope.hosted.setRecords(domain.id, ids);
  } catch (e) {
    // All or nothing: take back whatever was written, then forget the domain.
    for (const r of created.reverse()) {
      await writer.remove(r.id, r.name).then(() => zones.addCount(slot.key, -1)).catch(() => {});
    }
    await tenant.scope.mtaSts.delete(domain.id).catch(() => {});
    await tenant.scope.intake.delete(domain.id).catch(() => {});
    await tenant.scope.hosted.delete(domain.id).catch(() => {});
    if (e instanceof HostedError) throw e;
    if (e instanceof HostedNameError) throw new HostedError(e.message, 500);
    throw new HostedError(`Cloudflare rejected the hosted records: ${cfErrorText(e)}`, 502);
  }

  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action: 'hosted.enable', resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
    after_value: { hosted_id: hostedId, mta_sts: !!opts.mtaSts },
  }, ctx);

  return { hosted: (await view(tenant, domain))!, addresses: { rua: intakeAddress('rua', token, intakeDomain), tls_rpt: intakeAddress('tls-rpt', token, intakeDomain) } };
}

/** New intake token. The old one keeps working for 72 h; the hosted records are retargeted, so customers change nothing. */
export async function rotateHostedToken(
  tenant: TenantContext,
  domain: DomainRow,
  deps: HostedDeps = {},
  actor?: { id?: string | null; email?: string | null },
  ctx?: ExecutionContext,
): Promise<Addresses> {
  const { intakeDomain, apex } = requireHosted(tenant);
  const h = await tenant.scope.hosted.get(domain.id);
  if (!h || !h.dmarc_record_id || !h.tls_rpt_record_id) throw new HostedError('Hosted records are not enabled for this domain', 404);
  const writer = await writerFor(tenant, h.zone_key, deps);
  const names = hostedNames(h.hosted_id, apex);
  const token = generateToken();
  const rua = intakeAddress('rua', token, intakeDomain);
  const tls = intakeAddress('tls-rpt', token, intakeDomain);
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);

  // Publish the new address first, then accept it: a failure in between leaves the old token valid and in the records.
  try {
    const current = await writer.read(h.dmarc_record_id, names.dmarc);
    await writer.setContent(h.dmarc_record_id, names.dmarc, retargetRua(current.content, rua));
    await writer.setContent(h.tls_rpt_record_id, names.tlsRpt, buildHostedTlsRpt(token, intakeDomain));
  } catch (e) {
    throw new HostedError(`Could not update the hosted records: ${cfErrorText(e)}`, 502);
  }
  await tenant.scope.intake.set(domain.id, await hashToken(token), now);

  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action: 'hosted.rotate_token', resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
  }, ctx);
  return { rua, tls_rpt: tls };
}

export async function disableHosted(
  tenant: TenantContext,
  domain: DomainRow,
  deps: HostedDeps = {},
  actor?: { id?: string | null; email?: string | null },
  ctx?: ExecutionContext,
): Promise<void> {
  const { apex } = requireHosted(tenant);
  const h = await tenant.scope.hosted.get(domain.id);
  if (!h) throw new HostedError('Hosted records are not enabled for this domain', 404);
  const writer = await writerFor(tenant, h.zone_key, deps);
  const names = hostedNames(h.hosted_id, apex);
  const zones = globalQueries(tenant.db).hostedZones;
  const targets: Array<[string | null, string]> = [
    [h.dmarc_record_id, names.dmarc], [h.spf_record_id, names.spf], [h.tls_rpt_record_id, names.tlsRpt],
    [h.mta_sts_txt_record_id, names.mtaSts], [h.mta_sts_host_record_id, names.mtaSts],
  ];
  for (const [id, name] of targets) {
    if (!id) continue;
    try {
      if (await writer.remove(id, name)) await zones.addCount(h.zone_key, -1);
    } catch (e) {
      throw new HostedError(`Could not remove ${name}: ${cfErrorText(e)}`, 502);
    }
  }
  await tenant.scope.mtaSts.delete(domain.id);
  await tenant.scope.intake.delete(domain.id);
  await tenant.scope.hosted.delete(domain.id);
  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user',
    action: 'hosted.disable', resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
  }, ctx);
}

/** Check the customer's pointers now and store the result. */
export async function verifyDomainPointers(tenant: TenantContext, domain: DomainRow, deps: HostedDeps = {}): Promise<HostedView> {
  const { apex } = requireHosted(tenant);
  const h = await tenant.scope.hosted.get(domain.id);
  if (!h) throw new HostedError('Hosted records are not enabled for this domain', 404);
  const report = await verifyPointers(domain.domain, h.hosted_id, apex, deps.resolver);
  await tenant.scope.hosted.setPointers(domain.id, mergePointerReport(h, report), Math.floor((deps.now?.() ?? Date.now()) / 1000));
  return (await view(tenant, domain))!;
}

// ── MTA-STS on a hosted domain ──────────────────────────────
// The records behind mta_sts_config live in the hosted zone, so the legacy MTA-STS code (which patches the
// customer's own zone with these ids) must never touch them. These are the hosted equivalents.

/** A policy id that differs from `previous`: the timestamp id has one-second resolution, and an unchanged id would tell senders nothing changed. */
export function nextPolicyId(previous: string | null | undefined, now = new Date()): string {
  const id = generatePolicyId(now);
  return id === previous ? `${id}a` : id;
}

/** New policy id and/or mode and/or MX hosts for a hosted domain's MTA-STS. */
export async function updateHostedMtaSts(
  tenant: TenantContext,
  domain: DomainRow,
  change: { mode?: 'testing' | 'enforce'; mxHosts?: string[] },
  deps: HostedDeps = {},
): Promise<{ policy_id: string }> {
  const { apex } = requireHosted(tenant);
  const h = await tenant.scope.hosted.get(domain.id);
  const cfg = await tenant.scope.mtaSts.get(domain.id);
  if (!h?.mta_sts_txt_record_id || !cfg) throw new HostedError('MTA-STS is not enabled for this domain', 404);
  const writer = await writerFor(tenant, h.zone_key, deps);
  const policyId = nextPolicyId(cfg.policy_id, new Date(deps.now?.() ?? Date.now()));
  try {
    await writer.setContent(h.mta_sts_txt_record_id, hostedNames(h.hosted_id, apex).mtaSts, `v=STSv1; id=${policyId}`);
  } catch (e) {
    throw new HostedError(`Could not update the hosted MTA-STS record: ${cfErrorText(e)}`, 502);
  }
  if (change.mode) await tenant.scope.mtaSts.updateMode(domain.id, change.mode, policyId);
  if (change.mxHosts) await tenant.scope.mtaSts.updateMxHosts(domain.id, change.mxHosts.join(','), policyId);
  return { policy_id: policyId };
}

/** Remove only the hosted MTA-STS records and config; DMARC, SPF and TLS-RPT stay. */
export async function removeHostedMtaSts(tenant: TenantContext, domain: DomainRow, deps: HostedDeps = {}): Promise<void> {
  const { apex } = requireHosted(tenant);
  const h = await tenant.scope.hosted.get(domain.id);
  if (!h) throw new HostedError('Hosted records are not enabled for this domain', 404);
  const writer = await writerFor(tenant, h.zone_key, deps);
  const name = hostedNames(h.hosted_id, apex).mtaSts;
  const zones = globalQueries(tenant.db).hostedZones;
  for (const id of [h.mta_sts_txt_record_id, h.mta_sts_host_record_id]) {
    if (!id) continue;
    try {
      if (await writer.remove(id, name)) await zones.addCount(h.zone_key, -1);
    } catch (e) {
      throw new HostedError(`Could not remove ${name}: ${cfErrorText(e)}`, 502);
    }
  }
  await tenant.scope.hosted.setRecords(domain.id, { mta_sts_txt_record_id: null, mta_sts_host_record_id: null });
  await tenant.scope.mtaSts.delete(domain.id);
}
