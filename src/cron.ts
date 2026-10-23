// Cron work, one workspace at a time.
//
// A scheduled event fans out over the workspaces (self-host: just the one). Each workspace runs in
// its own try/catch, so one workspace's failure (a revoked Cloudflare token answering 403, a broken
// row) is logged and skipped instead of stopping the workspaces after it.

import type { BoundEnv } from './index';
import { loadTenant } from './tenancy/load';
import type { TenantContext } from './tenancy/context';
import { listCronWorkspaces, type ResolvedWorkspace } from './tenancy/resolver';
import { checkSubscription, detectRollbackRisk } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';
import { sendWeeklyDigests } from './digest/weekly';
import { logAudit } from './audit/log';
import { track } from './telemetry';
import { flattenSpf } from './email/spf-flattener';
import { lookupSpf } from './email/dns-check';
import { runRetention } from './lifecycle/retention';
import { retryRevocations } from './lifecycle/revoke';
import { discoverMxHosts, generatePolicyId, updateMtaStsTxtRecord } from './email/mta-sts';

const SPF_REFRESH_CONCURRENCY = 5;

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface CronOptions {
  /** Workspaces to cover. Default: listCronWorkspaces(env). */
  workspaces?: string[];
  /** How to build each workspace's TenantContext. Default: loadTenant. */
  load?: (env: BoundEnv, workspace: ResolvedWorkspace) => Promise<TenantContext>;
}

export async function runCronForWorkspaces(
  event: ScheduledController,
  env: BoundEnv,
  ctx: ExecutionContext,
  opts: CronOptions = {},
): Promise<void> {
  // Its own trigger, its own invocation: the sweeps must not eat the query budget of the per-workspace jobs.
  if (event.cron === LIFECYCLE_CRON) return runDataLifecycle(env);
  const load = opts.load ?? loadTenant;
  const workspaces = opts.workspaces ?? await listCronWorkspaces(env);
  for (const workspaceId of workspaces) {
    try {
      const tenant = await load(env, { workspaceId });
      await runCron(event, tenant, ctx);
    } catch (e) {
      console.error(`[cron ${event.cron}] workspace ${workspaceId} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    }
  }
}

/** Daily at 04:00 UTC, once for the whole database (not per workspace): retry failed Cloudflare revocations, then the retention sweeps. */
export const LIFECYCLE_CRON = '0 4 * * *';

export async function runDataLifecycle(env: BoundEnv): Promise<void> {
  // Revocations first: they are few, and leaving a grant live matters more than a late sweep.
  try { await retryRevocations(env); } catch (e) { console.error('[lifecycle] revocation retry failed:', e); }
  try { await runRetention(env); } catch (e) { console.error('[retention] failed:', e); }
}

/** One cron tick for one workspace. */
async function runCron(event: ScheduledController, tenant: TenantContext, ctx: ExecutionContext): Promise<void> {
  // Daily telemetry heartbeat — every day 11am UTC
  if (event.cron === '0 11 * * *') {
    try {
      const stats = await tenant.scope.heartbeat();
      await track(tenant, { event: 'instance.heartbeat', ...stats });
    } catch (e) {
      console.error('[telemetry] heartbeat failed:', e);
    }
    return;
  }

  // Weekly digest — every Monday 9am UTC
  if (event.cron === '0 9 * * 1') {
    await sendWeeklyDigests(tenant);
    return;
  }

  // Daily SPF flatten refresh — every day 10am UTC
  if (event.cron === '0 10 * * *') {
    if (tenant.hasCloudflare()) {
      const configs = await tenant.scope.spf.allEnabled();
      console.log(`[spf-flatten] refreshing ${configs.length} flattened domains`);
      for (const config of configs) {
        const domain = await tenant.scope.domains.getById(config.domain_id);
        if (!domain) continue;
        try {
          const result = await flattenSpf(tenant, domain.domain, config.cf_record_id);
          await tenant.scope.spf.updateResult(config.domain_id, result.flattened_record, result.ip_count, result.cf_record_id);
          console.log(`[spf-flatten] ${domain.domain}: updated (${result.ip_count} IPs)`);
          logAudit(tenant, {
            actor_type: 'system',
            action: 'spf_flatten.update',
            resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
            before_value: { spf_record: config.flattened_record ?? config.canonical_record },
            after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
            meta: { cron: '0 10 * * *' },
          }, ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await tenant.scope.spf.updateError(config.domain_id, msg);
          console.error(`[spf-flatten] ${domain.domain}: error — ${msg}`);
        }
      }
    }
    return;
  }

  // Daily monitor check — every day 8am UTC (default / catch-all)
  // Also refresh SPF lookup counts for all domains
  const allDomains = await tenant.scope.domains.list();
  // Awaited (a floating promise can be cut off when the invocation ends), a few at a time.
  await mapLimit(allDomains, SPF_REFRESH_CONCURRENCY, async d => {
    try {
      const spf = await lookupSpf(d.domain);
      if (spf?.lookup_count !== undefined) {
        await tenant.scope.domains.updateSpfLookupCount(d.id, spf.lookup_count);
      }
    } catch (e) {
      console.warn(`[monitor] SPF lookup refresh failed for ${d.domain}:`, e);
    }
  });

  // Rollback regression check — for domains actively in a staged rollout
  for (const d of allDomains) {
    if (!d.rollout_rec_policy || d.rollout_rec_pct == null) continue;
    try {
      const now = Math.floor(Date.now() / 1000);
      const [curr, prev] = await Promise.all([
        tenant.scope.reports.dailyStats(d.id, now - 7 * 86400),
        tenant.scope.reports.dailyStats(d.id, now - 14 * 86400),
      ]);
      const currRows = curr;
      const prevRows = prev.filter(r => r.day < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      const rate = (rows: typeof currRows) => {
        const t = rows.reduce((n, r) => n + r.total, 0);
        const p = rows.reduce((n, r) => n + r.passed, 0);
        return t > 0 ? Math.round((p / t) * 100) : null;
      };
      const currRate = rate(currRows);
      const prevRate = rate(prevRows);
      if (detectRollbackRisk(currRate, prevRate)) {
        console.warn(`[rollout] ${d.domain}: pass rate dropped from ${prevRate}% to ${currRate}% after step ${d.rollout_rec_policy}${d.rollout_rec_pct === 0 ? ' (t=y)' : ''} — rollback recommended`);
      }
    } catch (e) {
      console.error(`[rollout] regression check failed for ${d.domain}:`, e);
    }
  }

  // MTA-STS MX refresh — update policy_id in DNS if MX hosts changed
  if (tenant.hasCloudflare()) {
    const mtaConfigs = await tenant.scope.mtaSts.allEnabled();
    for (const cfg of mtaConfigs) {
      const domain = await tenant.scope.domains.getById(cfg.domain_id);
      if (!domain) continue;
      // Hosted MTA-STS records live in the hosted zone: src/hosted/cron.ts refreshes those.
      if (await tenant.scope.hosted.get(cfg.domain_id)) continue;
      try {
        const liveMx = await discoverMxHosts(domain.domain);
        if (liveMx.length === 0) {
          // No MX answer: never publish an MTA-STS policy that lists no mx hosts.
          console.warn(`[mta-sts] ${domain.domain}: no MX records found, leaving policy unchanged`);
          continue;
        }
        const storedMx = cfg.mx_hosts ? cfg.mx_hosts.split(',').filter(Boolean) : [];
        // Compare as sets: DNS answer order is not stable
        const sortedLive = [...liveMx].sort();
        const sortedStored = [...storedMx].sort();
        const changed = sortedLive.length !== sortedStored.length || sortedLive.some((h, i) => h !== sortedStored[i]);
        if (changed && cfg.mta_sts_record_id) {
          const newPolicyId = generatePolicyId();
          await updateMtaStsTxtRecord(tenant, domain.domain, cfg.mta_sts_record_id, newPolicyId);
          await tenant.scope.mtaSts.updateMxHosts(cfg.domain_id, liveMx.join(','), newPolicyId);
          console.log(`[mta-sts] ${domain.domain}: MX changed, policy_id updated`);
          logAudit(tenant, {
            actor_type: 'system',
            action: 'cron.mta_sts_mx',
            resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
            before_value: { mx_hosts: storedMx, policy_id: cfg.policy_id },
            after_value: { mx_hosts: liveMx, policy_id: newPolicyId },
            meta: { cron: '0 8 * * *' },
          }, ctx);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await tenant.scope.mtaSts.updateError(cfg.domain_id, msg);
        console.error(`[mta-sts] ${domain.domain}: MX refresh error — ${msg}`);
      }
    }
  }

  const subscriptions = await tenant.scope.monitor.active(200);
  console.log(`[monitor] checking ${subscriptions.length} subscriptions`);

  for (const sub of subscriptions) {
    try {
      const { changes, newBaseline, errors } = await checkSubscription(sub);
      if (errors.spf || errors.dmarc) {
        console.warn(`[monitor] ${sub.domain}: DNS lookup failed, baseline kept (${[errors.spf, errors.dmarc].filter(Boolean).join('; ')})`);
      }
      await tenant.scope.monitor.updateBaseline(sub.id, newBaseline);

      if (changes.length > 0) {
        console.log(`[monitor] ${sub.domain} changed: ${changes.map(c => c.field).join(', ')}`);
        await sendChangeNotification(sub.email, sub.domain, changes, tenant);
      }
    } catch (e) {
      console.error(`[monitor] error checking ${sub.domain}:`, e);
    }
  }
}
