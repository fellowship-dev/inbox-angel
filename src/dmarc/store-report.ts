// Stores a parsed DMARC aggregate report into D1: the report row, its records and the storage counters in ONE db.batch()
// (packages/db/src/queries/report-store.ts). All or nothing, one query against the invocation's budget however many records
// there are. A re-delivery of the same report id stores nothing (returns { stored: false }).

import { AggregateReport, ReportRecord as ParserRecord } from './types';
import type { TenantContext } from '../tenancy/context';
import type { RecordTuple } from '@ready-set-mail/db';
import { rawXmlRetentionDays } from '../lifecycle/config';
import { sendFirstReportNotification } from '../notifications/first-report';
import type { ReporterInfo } from './reporter-auth';
export type { ReporterInfo };

export interface StoreReportResult {
  stored: boolean;       // false = duplicate, nothing written
  superseded?: number;   // uncounted reports with this id replaced by this counted one
  reportId?: number;     // D1 auto-increment id of the aggregate_reports row
  statements?: number;   // statements in the storing batch (for the log)
}

// ── Helpers ───────────────────────────────────────────────────

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// A record "passes" DMARC if at least one of dkim or spf aligned.
// Weighted by message count (each record represents N messages from the same IP).
function computeCounts(records: ParserRecord[]): {
  total: number;
  pass: number;
  fail: number;
} {
  let total = 0;
  let pass = 0;

  for (const rec of records) {
    const count = rec.count;
    total += count;
    const dkimPass = rec.policy_evaluated.dkim === 'pass';
    const spfPass  = rec.policy_evaluated.spf  === 'pass';
    if (dkimPass || spfPass) pass += count;
  }

  return { total, pass, fail: total - pass };
}

/** A parser record as the row tuple the storing batch reads (column order: packages/db/src/queries/report-store.ts). */
export function toTuple(rec: ParserRecord): RecordTuple {
  return [
    rec.source.ip,
    rec.count,
    rec.policy_evaluated.disposition,
    rec.auth_results.dkim[0]?.result ?? null,
    rec.auth_results.dkim[0]?.domain ?? null,
    rec.auth_results.spf[0]?.result ?? null,
    rec.auth_results.spf[0]?.domain ?? null,
    rec.identifiers.header_from,
    rec.source.reverse_dns,
    rec.source.base_domain,
    rec.source.country_code,
    rec.source.org ?? null,
  ];
}

// ── Main export ───────────────────────────────────────────────

/**
 * Inserts an aggregate report + its records into D1, atomically.
 *
 * @param tenant      the workspace the report is stored for
 * @param domainId    D1 domains.id for the monitored domain
 * @param report      Parsed AggregateReport from parseDmarcEmail()
 * @param rawXml      Original XML string to store for reprocessing (nullable)
 * @param notifyFirstReport  send the first-report notification email when this is the domain's first counted report
 * @param reporter what the intake decided about the sender: tier, authenticated domain, known organisation
 * @throws when D1 fails: nothing of the report is stored then (the caller decides what the sender is told)
 */
export async function storeReport(
  tenant: TenantContext,
  domainId: number,
  report: AggregateReport,
  rawXml: string | null = null,
  notifyFirstReport = false,
  reporter?: ReporterInfo,
): Promise<StoreReportResult> {
  const { total, pass, fail } = computeCounts(report.records);
  const meta = report.report_metadata;
  const q = tenant.scope;

  const res = await q.reports.storeAtomic({
    domainId,
    report: {
      org_name: meta.org_name,
      // Every report with a reporter identity is stored as '<identity>|<id>' (the registry id for a counted report): the unique key is (domain, reporter,
      // report id), so two known reporters may reuse one id and a forger cannot squat a real reporter's id. A report with no reporter (callers outside the
      // intake) keeps its plain id, like every row stored before 0010.
      report_id: reporter ? `${reporter.identity}|${meta.report_id}` : meta.report_id,
      date_begin: isoToUnix(meta.begin_date),
      date_end: isoToUnix(meta.end_date),
      total_count: total,
      pass_count: pass,
      fail_count: fail,
      // RAW_XML_RETENTION_DAYS=0 (the hosted default): the parsed rows are kept, the original XML is not
      raw_xml: rawXmlRetentionDays(tenant.env) > 0 ? rawXml : null,
      reporter_auth: reporter?.auth ?? null,
      reporter_auth_domain: reporter?.domain ?? null,
      reporter_auth_reason: reporter?.reason ?? null,
      reporter_tier: reporter?.tier ?? null,
      reporter_known_as: reporter?.knownAs ?? null,
      reporter_identity: reporter?.identity ?? null,
    },
    records: report.records.map(toTuple),
    supersedeXmlId: reporter?.tier === 'counted' ? meta.report_id : undefined,
    ingestToken: crypto.randomUUID(),
    day: new Date().toISOString().slice(0, 10),
  });
  if (!res.stored) return { stored: false };

  // Fire first-report notification if this is the very first report that counts for this domain
  if (notifyFirstReport) {
    const reportCount = await q.reports.countForDomain(domainId);

    if (reportCount === 1) {
      const domainRow = await q.domains.getById(domainId);

      if (domainRow) {
        const uniqueSources = new Set(report.records.map(r => r.source.ip));
        void sendFirstReportNotification(tenant, domainRow.domain, {
          totalMessages: total,
          passMessages: pass,
          failMessages: fail,
          sourceCount: uniqueSources.size,
        })?.catch(() => {}); // fire-and-forget
      }
    }
  }

  return { stored: true, reportId: res.reportId, statements: res.statements, superseded: res.superseded };
}
