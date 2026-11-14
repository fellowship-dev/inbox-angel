// The daily retention job: delete what the published windows (docs/data-retention.md) no longer allow us to keep.
//
// Global, not per workspace: it runs once per day over every table. Each sweep deletes in batches (D1 limits),
// is idempotent, and logs one JSON line with the counts, which is also what runRetention returns. A failing
// sweep is logged and the others still run. The whole run shares one statement budget (D1 caps queries per
// invocation), so a big backlog is worked off over several days; truncated sweeps say so in the log line. Expired canary tokens are purged by src/hosted/cron.ts, as before.

import { lifecycleQueries, sweepLimits, type SweepResult } from '@ready-set-mail/db';
import { retentionPolicy, type RetentionEnv } from './config';
import { reportCounting } from '../dmarc/counting';

const DAY = 86400;
const dayOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export interface RetentionOptions {
  /** The clock, in ms. Default Date.now. */
  now?: () => number;
  /** Test knobs: rows per statement, and the run's total statement budget (default 300). */
  limits?: { batch?: number; recordBatch?: number; statements?: number };
}

export type RetentionReport = Record<string, number | boolean | string>;

export async function runRetention(env: RetentionEnv & { DB: D1Database }, opts: RetentionOptions = {}): Promise<RetentionReport> {
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const p = retentionPolicy(env);
  const q = lifecycleQueries(env.DB);
  const limits = sweepLimits(opts.limits);
  const ago = (d: number) => now - d * DAY;
  // Uncounted-tier reports (unknown or unauthenticated) are short-lived only where they never feed the numbers. With REPORT_COUNTING=all (the self-host
  // default) they ARE the numbers (a server with AUTHSERV_* unset stores every report as unauthenticated), so they keep the normal window.
  const unauthCutoff = reportCounting(env) === 'all' ? undefined : ago(p.uncountedReportsDays);

  const report: RetentionReport = {};
  const sweeps: Array<[string, () => Promise<SweepResult>]> = [
    ['aggregate_reports', () => q.purgeAggregateReports(ago(p.reportsDays), limits, unauthCutoff)],
    ['tls_reports', () => q.purgeTlsReports(ago(p.tlsDays), limits)],
    // 0 days: raw XML is never stored, so clear anything still there
    ['raw_xml_cleared', () => q.clearRawXml(ago(p.rawDays), limits)],
    ['tls_raw_cleared', () => q.clearTlsRaw(ago(p.rawDays), limits)],
    ['ip_info', () => q.purgeIpInfo(ago(p.ipInfoDays), limits)],
    ['check_results', () => q.purgeCheckResults(ago(p.checkResultsDays), limits)],
    ['sessions', () => q.purgeSessions(now, limits)],
    ['verifications', () => q.purgeVerifications(now, limits)],
    ['password_reset_tokens', () => q.purgeResetTokens(now, limits)],
    ['invites', () => q.purgeInvites(ago(p.invitesDays), limits)],
    ['evicted_domains', () => q.purgeEvictedDomains(ago(p.evictedDays), limits)],
    // A settled claim is kept one day, only so a repeat verify of it answers 200.
    ['settled_claims', () => q.purgeSettledClaims(ago(1), limits)],
    ['audit_log', () => q.purgeAudit(ago(p.auditDays), limits)],
    // Intake counters: daily caps need only today and yesterday; the failure markers live longer so an owner can see them.
    ['intake_counters', () => q.purgeIntakeCounters(dayOf(ago(p.intakeCounterDays)), limits)],
    ['intake_failures', () => q.purgeIntakeFailures(dayOf(ago(p.intakeFailureDays)), limits)],
    ['intake_drops', () => q.purgeIntakeDrops(ago(p.intakeFailureDays), limits)],
    ['reporter_candidates', () => q.purgeReporterCandidates(dayOf(ago(p.intakeFailureDays)), limits)],
    // Last: recount a few workspaces' stored records (repairs drift, counts data stored before the counters existed).
    ['storage_reconciled', () => q.reconcileStorage(limits)],
  ];
  let failed = 0;
  for (const [name, sweep] of sweeps) {
    try {
      const r = await sweep();
      report[name] = r.deleted;
      if (r.truncated) report[`${name}_truncated`] = true;
    } catch (e) {
      failed++;
      report[`${name}_error`] = e instanceof Error ? e.message : String(e);
      console.error(`[retention] ${name} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : e);
    }
  }
  report.failed = failed;
  report.statements_left = Math.max(0, limits.budget.left);
  console.log(`[retention] ${JSON.stringify(report)}`);
  return report;
}
