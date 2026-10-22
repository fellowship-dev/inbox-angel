// Daily hosted jobs (MODE=saas, SAAS_ENABLED=1), run once per day after the per-account cron:
//   1. reconcile the hosted zone: count every record (quota), warn at 3,200, and diff what is there against
//      what the database says we wrote. Records outside `*.h.<zone>` are only counted and fingerprinted, never
//      touched: the job reports a change in them, it can't make one.
//   2. re-flatten every hosted SPF from its stored source (provider IP ranges change).
//   3. verify every hosted domain's pointers in the customer's DNS.
//   4. forget expired canary addresses.
//
// It piggybacks on the existing 11:00 UTC schedule, so no new trigger is needed in wrangler.jsonc.

import type { BoundEnv } from '../index';
import { globalQueries, intakeLookups, forAccount } from '@inbox-angel/db';
import { mapLimit } from '../cron';
import { hostedApex, hostedConfig, hostedEnabled } from './config';
import { hostedNames, openHostedZone } from './records';
import { assessQuota, configuredZones, type ZoneQuota } from './zones';
import { mergePointerReport, verifyPointers } from './pointers';
import { createResolver, type Resolver } from '@inbox-angel/dns-checks';
import { flattenSource } from './spf';
import { discoverMxHosts } from '../email/mta-sts';
import { nextPolicyId } from './service';

export const HOSTED_CRON = '0 11 * * *';

export interface ZoneReport {
  zone: string;
  quota: ZoneQuota;
  /** Records we expect (from the database) that the zone doesn't have. Reported, not recreated: the DMARC/TLS-RPT content carries a token we no longer hold. */
  missing: string[];
  /** Records under the hosted label that no domain accounts for. Reported, never deleted. */
  orphans: string[];
  /** The records outside the hosted label differ from yesterday's fingerprint. */
  restChanged: boolean;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function reconcileZones(env: BoundEnv, opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<ZoneReport[]> {
  const cfg = hostedConfig(env);
  const apex = hostedApex(cfg);
  const reports: ZoneReport[] = [];
  if (!apex) return reports;
  const db = globalQueries(env.DB);
  const allHosted = await intakeLookups(env.DB).allHosted();

  for (const slot of configuredZones(env)) {
    const writer = await openHostedZone(env, slot.name, { fetch: opts.fetch });
    await db.hostedZones.upsert({ zone_key: slot.key, zone_id: writer.zone.id, zone_name: writer.zone.name });
    const records = await writer.listAll();
    const ours = records.filter(r => r.name.toLowerCase().endsWith(`.${apex}`));
    const rest = records.filter(r => !r.name.toLowerCase().endsWith(`.${apex}`));

    const expected = new Map<string, string>(); // record id → name
    for (const h of allHosted.filter(h => h.zone_key === slot.key)) {
      const names = hostedNames(h.hosted_id, apex);
      const ids: Array<[string | null, string]> = [
        [h.dmarc_record_id, names.dmarc], [h.spf_record_id, names.spf], [h.tls_rpt_record_id, names.tlsRpt],
        [h.mta_sts_txt_record_id, names.mtaSts], [h.mta_sts_host_record_id, names.mtaSts],
      ];
      for (const [id, name] of ids) if (id) expected.set(id, name);
    }
    const present = new Set(ours.map(r => r.id));
    const missing = [...expected].filter(([id]) => !present.has(id)).map(([, name]) => name);
    const orphans = ours.filter(r => !expected.has(r.id)).map(r => r.name);

    const digest = await sha256Hex(rest.map(r => `${r.type} ${r.name.toLowerCase()} ${r.content}`).sort().join('\n'));
    const previous = (await db.hostedZones.get(slot.key))?.rest_digest ?? null;
    const restChanged = previous !== null && previous !== digest;
    await db.hostedZones.setObserved(slot.key, records.length, digest, Math.floor((opts.now?.() ?? Date.now()) / 1000));

    const quota = assessQuota(records.length);
    if (quota.level !== 'ok') console.warn(`[hosted] zone ${slot.name} holds ${quota.count}/${quota.limit} records (${quota.level})`);
    if (missing.length) console.error(`[hosted] zone ${slot.name}: ${missing.length} expected record(s) missing: ${missing.slice(0, 10).join(', ')}`);
    if (orphans.length) console.warn(`[hosted] zone ${slot.name}: ${orphans.length} record(s) under ${apex} belong to no domain: ${orphans.slice(0, 10).join(', ')}`);
    if (restChanged) console.warn(`[hosted] zone ${slot.name}: records outside ${apex} changed since the last run (not ours; left alone)`);
    reports.push({ zone: slot.name, quota, missing, orphans, restChanged });
  }
  return reports;
}

/** Check the pointers of every hosted domain, a few at a time. A failed lookup keeps the previous status. */
export async function verifyAllPointers(env: BoundEnv, opts: { resolver?: Resolver; now?: () => number } = {}): Promise<number> {
  const apex = hostedApex(hostedConfig(env));
  if (!apex) return 0;
  const rows = await intakeLookups(env.DB).allHosted();
  let checked = 0;
  await mapLimit(rows, 5, async h => {
    try {
      const q = forAccount(env.DB, h.account_id);
      const domain = await q.domains.getById(h.domain_id);
      if (!domain) return;
      const r = await verifyPointers(domain.domain, h.hosted_id, apex, opts.resolver);
      await q.hosted.setPointers(h.domain_id, mergePointerReport(h, r), Math.floor((opts.now?.() ?? Date.now()) / 1000));
      checked++;
    } catch (e) {
      console.error(`[hosted] pointer check failed for domain ${h.domain_id}:`, e instanceof Error ? e.message : e);
    }
  });
  return checked;
}

/**
 * Re-flatten every hosted SPF from its stored source and update the record when the result changed.
 * A source that can't be fully resolved today leaves yesterday's record in place (a partial one would drop senders).
 */
export async function refreshHostedSpf(env: BoundEnv, opts: { fetch?: typeof fetch; resolver?: Resolver } = {}): Promise<{ updated: number; failed: number }> {
  const apex = hostedApex(hostedConfig(env));
  const out = { updated: 0, failed: 0 };
  if (!apex) return out;
  const resolver = opts.resolver ?? createResolver();
  const rows = (await intakeLookups(env.DB).allHosted()).filter(h => h.spf_record_id && h.spf_source);
  const writers = new Map<string, Awaited<ReturnType<typeof openHostedZone>>>();
  for (const h of rows) {
    try {
      const slot = configuredZones(env).find(z => z.key === h.zone_key);
      if (!slot) throw new Error(`unknown zone ${h.zone_key}`);
      let writer = writers.get(slot.key);
      if (!writer) writers.set(slot.key, writer = await openHostedZone(env, slot.name, { fetch: opts.fetch }));
      const domain = await forAccount(env.DB, h.account_id).domains.getById(h.domain_id);
      if (!domain) continue;
      const flat = await flattenSource(domain.domain, h.spf_source!, resolver);
      if (!flat.ok) throw new Error(flat.errors.map(e => e.message).join('; '));
      const name = hostedNames(h.hosted_id, apex).spf;
      const current = await writer.read(h.spf_record_id!, name);
      if (current.content === flat.content) continue;
      await writer.setContent(h.spf_record_id!, name, flat.content);
      out.updated++;
    } catch (e) {
      out.failed++;
      console.error(`[hosted] SPF refresh failed for domain ${h.domain_id} (record kept as is):`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** The MX-change refresh for hosted MTA-STS: same rule as the legacy job (never publish a policy without MX hosts), but through the hosted writer. */
export async function refreshHostedMtaStsMx(env: BoundEnv, opts: { fetch?: typeof fetch; discover?: (domain: string) => Promise<string[]> } = {}): Promise<number> {
  const apex = hostedApex(hostedConfig(env));
  if (!apex) return 0;
  const discover = opts.discover ?? discoverMxHosts;
  let updated = 0;
  for (const h of (await intakeLookups(env.DB).allHosted()).filter(h => h.mta_sts_txt_record_id)) {
    try {
      const q = forAccount(env.DB, h.account_id);
      const [domain, cfg] = await Promise.all([q.domains.getById(h.domain_id), q.mtaSts.get(h.domain_id)]);
      if (!domain || !cfg?.enabled) continue;
      const live = await discover(domain.domain);
      if (live.length === 0) { console.warn(`[hosted] ${domain.domain}: no MX records found, leaving the MTA-STS policy unchanged`); continue; }
      const stored = cfg.mx_hosts ? cfg.mx_hosts.split(',').filter(Boolean) : [];
      if ([...live].sort().join() === [...stored].sort().join()) continue;
      const slot = configuredZones(env).find(z => z.key === h.zone_key);
      if (!slot) continue;
      const writer = await openHostedZone(env, slot.name, { fetch: opts.fetch });
      const policyId = nextPolicyId(cfg.policy_id);
      await writer.setContent(h.mta_sts_txt_record_id!, hostedNames(h.hosted_id, apex).mtaSts, `v=STSv1; id=${policyId}`);
      await q.mtaSts.updateMxHosts(h.domain_id, live.join(','), policyId);
      updated++;
    } catch (e) {
      console.error(`[hosted] MTA-STS MX refresh failed for domain ${h.domain_id}:`, e instanceof Error ? e.message : e);
    }
  }
  return updated;
}

export async function runHostedCron(event: ScheduledController, env: BoundEnv, _ctx: ExecutionContext): Promise<void> {
  if (!hostedEnabled(env) || event.cron !== HOSTED_CRON) return;
  for (const [name, job] of [
    ['zone reconcile', () => reconcileZones(env)],
    ['SPF refresh', () => refreshHostedSpf(env)],
    ['MTA-STS MX refresh', () => refreshHostedMtaStsMx(env)],
    ['pointer verification', () => verifyAllPointers(env)],
    ['canary purge', () => globalQueries(env.DB).canary.purgeExpired(Math.floor(Date.now() / 1000))],
  ] as const) {
    try { await job(); } catch (e) { console.error(`[hosted] ${name} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : e); }
  }
}
