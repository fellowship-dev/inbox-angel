// Stores a parsed DMARC aggregate report into D1.
// Handles deduplication via INSERT OR IGNORE — re-deliveries of the same
// report_id are silently skipped (returns { stored: false }).

import { AggregateReport, ReportRecord as ParserRecord } from './types';
import type { TenantContext } from '../tenancy/context';
import { ReportRecord as DbRecord } from '../db/types';
import { rawXmlRetentionDays } from '../lifecycle/config';
import { sendFirstReportNotification } from '../notifications/first-report';

export interface StoreReportResult {
  stored: boolean;       // false = duplicate, records not re-inserted
  reportId?: number;     // D1 auto-increment id of the aggregate_reports row
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

// Maps a parser ReportRecord to a D1 report_records row.
function mapRecord(
  rec: ParserRecord,
  reportId: number,
): Omit<DbRecord, 'id' | 'created_at'> {
  return {
    report_id: reportId,
    source_ip: rec.source.ip,
    count: rec.count,
    disposition: rec.policy_evaluated.disposition,
    dkim_result: (rec.auth_results.dkim[0]?.result ?? null) as DbRecord['dkim_result'],
    dkim_domain: rec.auth_results.dkim[0]?.domain ?? null,
    spf_result:  (rec.auth_results.spf[0]?.result  ?? null) as DbRecord['spf_result'],
    spf_domain:  rec.auth_results.spf[0]?.domain  ?? null,
    header_from: rec.identifiers.header_from,
    reverse_dns: rec.source.reverse_dns,
    base_domain: rec.source.base_domain,
    country_code: rec.source.country_code,
    org: rec.source.org ?? null,
  };
}

// ── Main export ───────────────────────────────────────────────

/**
 * Inserts an aggregate report + its records into D1.
 *
 * @param tenant      the workspace the report is stored for
 * @param domainId    D1 domains.id for the monitored domain
 * @param report      Parsed AggregateReport from parseDmarcEmail()
 * @param rawXml      Original XML string to store for reprocessing (nullable)
 * @param notifyFirstReport  send the first-report notification email when this is the domain's first report
 */
export async function storeReport(
  tenant: TenantContext,
  domainId: number,
  report: AggregateReport,
  rawXml: string | null = null,
  notifyFirstReport = false,
): Promise<StoreReportResult> {
  const { total, pass, fail } = computeCounts(report.records);
  const meta = report.report_metadata;

  const q = tenant.scope;
  const insertResult = await q.reports.insertAggregate({
    domain_id:   domainId,
    org_name:    meta.org_name,
    report_id:   meta.report_id,
    date_begin:  isoToUnix(meta.begin_date),
    date_end:    isoToUnix(meta.end_date),
    total_count: total,
    pass_count:  pass,
    fail_count:  fail,
    // RAW_XML_RETENTION_DAYS=0 (the hosted default): the parsed rows are kept, the original XML is not
    raw_xml:     rawXmlRetentionDays(tenant.env) > 0 ? rawXml : null,
  });

  // ON CONFLICT DO NOTHING — no row written means this report was already delivered
  const reportId = insertResult.meta?.changes ? insertResult.meta.last_row_id : 0;
  if (!reportId) return { stored: false };

  // Batch-insert all per-IP records
  if (report.records.length > 0) {
    await q.reports.insertRecords(
      report.records.map(r => mapRecord(r, reportId)),
    );
  }

  // Fire first-report notification if this is the very first report for this domain
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

  return { stored: true, reportId };
}
