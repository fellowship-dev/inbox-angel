import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { aggregateReports, domains, reportRecords, tlsReports } from '../schema';

export interface DomainWeeklyStat {
	domain_id: number;
	domain: string;
	dmarc_policy: string | null;
	total_messages: number;
	pass_messages: number;
	fail_messages: number;
	report_count: number;
}

export interface FailingSource {
	source_ip: string;
	total: number;
	header_from: string | null;
	base_domain?: string | null;
	org?: string | null;
}

export interface AnomalySource {
	source_ip: string;
	header_from: string | null;
	spf_domain: string | null;
	dkim_domain: string | null;
	total: number;
	spf_pass: number; // 1 if any record had spf pass in window
	dkim_pass: number; // 1 if any record had dkim pass in window
	first_seen: string; // YYYY-MM-DD
	last_seen: string; // YYYY-MM-DD
	base_domain: string | null;
	org: string | null;
}

export interface DailyDomainStat {
	day: string;
	total: number;
	passed: number;
	failed: number;
}

export interface ReportSource {
	source_ip: string;
	header_from: string | null;
	spf_domain: string | null;
	dkim_domain: string | null;
	count: number;
	spf_pass: number;
	dkim_pass: number;
	disposition: string;
	reporters: string; // comma-separated org names
}

export interface DayReportSummary {
	total: number;
	passed: number;
	failed: number;
}

export interface ExportRow {
	date: string;
	org_name: string;
	total_count: number;
	pass_count: number;
	fail_count: number;
	source_ip: string | null;
	header_from: string | null;
	spf_result: string | null;
	spf_domain: string | null;
	dkim_result: string | null;
	dkim_domain: string | null;
	record_count: number | null;
	disposition: string | null;
}

export interface DomainCheckSummary {
	domain_id: number;
	domain: string;
	dmarc_policy: string | null;
	spf_record: string | null;
	total_messages: number;
	pass_messages: number;
	fail_messages: number;
	dkim_total: number;
	dkim_pass: number;
	spf_total: number;
	spf_pass: number;
	mta_sts_enabled: number; // 0 or 1
	mta_sts_mode: string | null;
}

type NewReport = Omit<typeof aggregateReports.$inferInsert, 'id' | 'created_at' | 'workspace_id'>;
type NewRecord = Omit<typeof reportRecords.$inferInsert, 'id' | 'created_at' | 'workspace_id'>;
type NewTlsReport = Omit<typeof tlsReports.$inferInsert, 'id' | 'created_at' | 'workspace_id'>;

/** Sanitized references only: source payloads and authentication headers never enter reports. */
export interface ReportEvidenceRow {
  id: number;
  source_report_id: string | null;
  reporter: string;
  date_begin: number;
  date_end: number;
  created_at: number;
  total_count: number;
  pass_count: number;
  fail_count: number;
}
interface EvidenceSummaryRow {
  report_count: number;
  latest_period_end: number | null;
  latest_received_at: number | null;
}

export function reportQueries(db: Db, workspaceId: string) {
	const A = sql`${workspaceId}`;

	return {
		insertAggregate(r: NewReport) {
			// Re-delivered reports (same domain_id + report_id) are ignored.
			return db.insert(aggregateReports).values({ ...r, workspace_id: workspaceId }).onConflictDoNothing().run();
		},

		insertRecords(records: NewRecord[]) {
			const rows = records.map((r) => db.insert(reportRecords).values({ ...r, workspace_id: workspaceId }));
			return db.batch(rows as [(typeof rows)[number], ...(typeof rows)[number][]]);
		},

		/** Most recent aggregate reports across the workspace's domains. */
		recent(limit = 30) {
			return db
				.select({ r: aggregateReports, domain: domains.domain })
				.from(aggregateReports)
				.innerJoin(domains, and(eq(domains.id, aggregateReports.domain_id), eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at)))
				.where(eq(aggregateReports.workspace_id, workspaceId))
				.orderBy(desc(aggregateReports.date_begin))
				.limit(limit)
				.all()
				.then((rows) => rows.map((x) => ({ ...x.r, domain: x.domain })));
		},

		/** One report with its domain name, or null. */
		getWithDomain(id: number) {
			return db
				.select({ r: aggregateReports, domain: domains.domain })
				.from(aggregateReports)
				.innerJoin(domains, and(eq(domains.id, aggregateReports.domain_id), eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at)))
				.where(and(eq(aggregateReports.workspace_id, workspaceId), eq(aggregateReports.id, id)))
				.get()
				.then((x) => (x ? { ...x.r, domain: x.domain } : null));
		},

		records(reportId: number) {
			return db
				.select()
				.from(reportRecords)
				.where(and(eq(reportRecords.workspace_id, workspaceId), eq(reportRecords.report_id, reportId)))
				.orderBy(desc(reportRecords.count))
				.all();
		},

		countForDomain(domainId: number) {
			return db
				.select({ cnt: sql<number>`COUNT(*)` })
				.from(aggregateReports)
				.where(and(eq(aggregateReports.workspace_id, workspaceId), eq(aggregateReports.domain_id, domainId)))
				.get()
				.then((r) => r?.cnt ?? 0);
		},

		// ── Digest / dashboard aggregates ─────────────────────────

		weeklyDomainStats(since: number) {
			return db.all<DomainWeeklyStat>(sql`
				SELECT
					d.id AS domain_id,
					d.domain,
					d.dmarc_policy,
					COALESCE(SUM(r.total_count), 0) AS total_messages,
					COALESCE(SUM(r.pass_count),  0) AS pass_messages,
					COALESCE(SUM(r.fail_count),  0) AS fail_messages,
					COUNT(r.id) AS report_count
				FROM domains d
				LEFT JOIN aggregate_reports r ON r.domain_id = d.id AND r.workspace_id = ${A} AND r.date_begin >= ${since}
				WHERE d.workspace_id = ${A} AND d.evicted_at IS NULL
				GROUP BY d.id, d.domain, d.dmarc_policy
				ORDER BY d.domain
			`);
		},

		topFailingSources(domainId: number, since: number, limit = 5) {
			return db.all<FailingSource>(sql`
				SELECT rr.source_ip, SUM(rr.count) AS total, rr.header_from,
				       MAX(rr.base_domain) AS base_domain, MAX(rr.org) AS org
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A}
				  AND ar.domain_id = ${domainId} AND ar.date_begin >= ${since}
				  AND (rr.dkim_result = 'fail' OR rr.spf_result = 'fail')
				GROUP BY rr.source_ip
				ORDER BY total DESC
				LIMIT ${limit}
			`);
		},

		anomalySources(domainId: number, since: number) {
			return db.all<AnomalySource>(sql`
				SELECT
					rr.source_ip,
					rr.header_from,
					rr.spf_domain,
					rr.dkim_domain,
					SUM(rr.count) AS total,
					MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
					MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
					MIN(date(datetime(ar.date_begin, 'unixepoch'))) AS first_seen,
					MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen,
					MAX(rr.base_domain) AS base_domain,
					MAX(rr.org) AS org
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A}
				  AND ar.domain_id = ${domainId}
				  AND ar.date_begin >= ${since}
				  AND (rr.spf_result != 'pass' OR rr.dkim_result != 'pass')
				GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain
				ORDER BY total DESC
			`);
		},

		allSources(domainId: number, since: number) {
			return db.all<AnomalySource>(sql`
				SELECT
					rr.source_ip,
					rr.header_from,
					rr.spf_domain,
					rr.dkim_domain,
					SUM(rr.count) AS total,
					MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
					MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
					MIN(date(datetime(ar.date_begin, 'unixepoch'))) AS first_seen,
					MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen,
					MAX(rr.base_domain) AS base_domain,
					MAX(rr.org) AS org
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A}
				  AND ar.domain_id = ${domainId}
				  AND ar.date_begin >= ${since}
				GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain
				ORDER BY total DESC
			`);
		},

		dailyStats(domainId: number, since: number) {
			return db.all<DailyDomainStat>(sql`
				SELECT
					date(datetime(date_begin, 'unixepoch')) AS day,
					SUM(total_count) AS total,
					SUM(pass_count)  AS passed,
					SUM(fail_count)  AS failed
				FROM aggregate_reports
				WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since}
				GROUP BY day
				ORDER BY day ASC
			`);
		},

		sourcesByDate(domainId: number, date: string) {
			return db.all<ReportSource>(sql`
				SELECT
					rr.source_ip,
					rr.header_from,
					rr.spf_domain,
					rr.dkim_domain,
					SUM(rr.count) AS count,
					MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
					MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
					rr.disposition,
					GROUP_CONCAT(DISTINCT ar.org_name) AS reporters
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A}
				  AND ar.domain_id = ${domainId}
				  AND date(datetime(ar.date_begin, 'unixepoch')) = ${date}
				GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain, rr.disposition
				ORDER BY count DESC
			`);
		},

		async daySummary(domainId: number, date: string): Promise<DayReportSummary | null> {
			const rows = await db.all<DayReportSummary>(sql`
				SELECT
					COALESCE(SUM(total_count), 0) AS total,
					COALESCE(SUM(pass_count),  0) AS passed,
					COALESCE(SUM(fail_count),  0) AS failed
				FROM aggregate_reports
				WHERE workspace_id = ${A}
				  AND domain_id = ${domainId}
				  AND date(datetime(date_begin, 'unixepoch')) = ${date}
			`);
			return rows[0] ?? null;
		},

		exportData(domainId: number) {
			return db.all<ExportRow>(sql`
				SELECT
					date(datetime(ar.date_begin, 'unixepoch')) AS date,
					ar.org_name,
					ar.total_count,
					ar.pass_count,
					ar.fail_count,
					rr.source_ip,
					rr.header_from,
					rr.spf_result,
					rr.spf_domain,
					rr.dkim_result,
					rr.dkim_domain,
					rr.count AS record_count,
					rr.disposition
				FROM aggregate_reports ar
				LEFT JOIN report_records rr ON rr.report_id = ar.id AND rr.workspace_id = ${A}
				WHERE ar.workspace_id = ${A} AND ar.domain_id = ${domainId}
				ORDER BY ar.date_begin DESC, rr.count DESC
			`);
		},

		async checkSummary(domainId: number, since: number): Promise<DomainCheckSummary | null> {
			const rows = await db.all<DomainCheckSummary>(sql`
				SELECT
					d.id            AS domain_id,
					d.domain,
					d.dmarc_policy,
					d.spf_record,
					COALESCE(SUM(ar.total_count), 0) AS total_messages,
					COALESCE(SUM(ar.pass_count),  0) AS pass_messages,
					COALESCE(SUM(ar.fail_count),  0) AS fail_messages,
					COALESCE(SUM(rr.count), 0)       AS dkim_total,
					COALESCE(SUM(CASE WHEN rr.dkim_result = 'pass' THEN rr.count ELSE 0 END), 0) AS dkim_pass,
					COALESCE(SUM(rr.count), 0)       AS spf_total,
					COALESCE(SUM(CASE WHEN rr.spf_result  = 'pass' THEN rr.count ELSE 0 END), 0) AS spf_pass,
					COALESCE(m.enabled, 0)           AS mta_sts_enabled,
					m.mode                           AS mta_sts_mode
				FROM domains d
				LEFT JOIN aggregate_reports ar ON ar.domain_id = d.id AND ar.workspace_id = ${A} AND ar.date_begin >= ${since}
				LEFT JOIN report_records rr    ON rr.report_id = ar.id AND rr.workspace_id = ${A}
				LEFT JOIN mta_sts_config m     ON m.domain_id = d.id AND m.workspace_id = ${A}
				WHERE d.workspace_id = ${A} AND d.id = ${domainId}
				GROUP BY d.id, d.domain, d.dmarc_policy, d.spf_record, m.enabled, m.mode
			`);
			return rows[0] ?? null;
		},

		// ── TLS-RPT ───────────────────────────────────────────────

		insertTls(r: NewTlsReport) {
			return db
				.insert(tlsReports)
				.values({ ...r, workspace_id: workspaceId })
				.onConflictDoUpdate({
					target: [tlsReports.domain_id, tlsReports.org_name, tlsReports.date_begin],
					set: {
						total_success: sql`excluded.total_success`,
						total_failure: sql`excluded.total_failure`,
						failure_details: sql`excluded.failure_details`,
						raw_json: sql`excluded.raw_json`,
					},
				})
				.run();
		},

    /** Bounded source references; summary and observed dates cover the entire selected range. */
    async evidence(domainId: number, since: number, until: number) {
      const [dmarc, tls, dmarcSummary, tlsSummary, dmarcDates, tlsDates] = await Promise.all([
        db.all<ReportEvidenceRow>(sql`SELECT id, report_id AS source_report_id, org_name AS reporter, date_begin, date_end, created_at, total_count, pass_count, fail_count FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} ORDER BY date_begin DESC, id DESC LIMIT 201`),
        db.all<ReportEvidenceRow>(sql`SELECT id, NULL AS source_report_id, org_name AS reporter, date_begin, date_end, created_at, total_success + total_failure AS total_count, total_success AS pass_count, total_failure AS fail_count FROM tls_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} ORDER BY date_begin DESC, id DESC LIMIT 201`),
        db.all<EvidenceSummaryRow>(sql`SELECT COUNT(*) AS report_count, MAX(date_end) AS latest_period_end, MAX(created_at) AS latest_received_at FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until}`),
        db.all<EvidenceSummaryRow>(sql`SELECT COUNT(*) AS report_count, MAX(date_end) AS latest_period_end, MAX(created_at) AS latest_received_at FROM tls_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until}`),
        db.all<{ day: string }>(sql`SELECT DISTINCT date(date_begin, 'unixepoch') AS day FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} ORDER BY day`),
        db.all<{ day: string }>(sql`SELECT DISTINCT date(date_begin, 'unixepoch') AS day FROM tls_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} ORDER BY day`),
      ]);
      const source = (rows: ReportEvidenceRow[], summary: EvidenceSummaryRow[], dates: { day: string }[]) => ({
        observations: rows.slice(0, 200), truncated: rows.length > 200,
        report_count: summary[0]?.report_count ?? 0,
        latest_period_end: summary[0]?.latest_period_end ?? null,
        latest_received_at: summary[0]?.latest_received_at ?? null,
        observed_dates: dates.map(row => row.day),
      });
      return { dmarc: source(dmarc, dmarcSummary, dmarcDates), tls: source(tls, tlsSummary, tlsDates) };
    },

		async tlsSummary(domainId: number, since: number, until?: number) {
			const rows = await db.all<{ total_success: number; total_failure: number; report_count: number }>(sql`
				SELECT
					COALESCE(SUM(total_success), 0) AS total_success,
					COALESCE(SUM(total_failure), 0) AS total_failure,
					COUNT(*) AS report_count
				FROM tls_reports
				WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since}
				${until === undefined ? sql`` : sql`AND date_begin <= ${until}`}
			`);
			return rows[0] ?? null;
		},
	};
}
