// The daily retention job: delete what the published windows (docs/data-retention.md) no longer allow us to keep.
//
// Global, not per workspace: it runs once per day over every table. Each sweep deletes in batches (D1 limits),
// is idempotent, and logs one JSON line with the counts, which is also what runRetention returns. A failing
// sweep is logged and the others still run. The whole run shares one statement budget (D1 caps queries per
// invocation), so a big backlog is worked off over several days; truncated sweeps say so in the log line. Expired canary tokens are purged by src/hosted/cron.ts, as before.

import { lifecycleQueries, sweepLimits, type SweepResult } from '@inbox-angel/db';
import { retentionPolicy, type RetentionEnv } from './config';

const DAY = 86400;

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

  const report: RetentionReport = {};
  const sweeps: Array<[string, () => Promise<SweepResult>]> = [
    ['aggregate_reports', () => q.purgeAggregateReports(ago(p.reportsDays), limits)],
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
    ['audit_log', () => q.purgeAudit(ago(p.auditDays), limits)],
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
