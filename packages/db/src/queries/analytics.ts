import { sql } from 'drizzle-orm';
import type { Db } from '../client';

/** How far back "first seen" can see. Older history is not scanned, so a sender first seen earlier reads as this old at most. */
export const FIRST_SEEN_HORIZON_DAYS = 180;

/**
 * One row per (source IP, authenticated domains and results, domain): the grain the sender inventory needs to
 * judge DMARC alignment, which D1 does not store per record (only the raw SPF/DKIM results and domains).
 * `count` covers the requested window; `first_seen`/`last_seen` (unix seconds) cover the whole horizon.
 */
export interface SenderRow {
	source_ip: string;
	domain_id: number;
	domain: string;
	header_from: string | null;
	spf_domain: string | null;
	spf_result: string | null;
	dkim_domain: string | null;
	dkim_result: string | null;
	messages: number;
	first_seen: number;
	last_seen: number;
	reverse_dns: string | null;
	base_domain: string | null;
	org: string | null;
	country_code: string | null;
}

export interface TrendRow {
	day: string;
	total: number;
	passed: number;
	failed: number;
}

/**
 * Read-only aggregates behind the analytics pages. Every statement is bound to the account, and `domainId`
 * (when given) is checked against the account's own domains by the join, so a foreign id yields no rows.
 */
export function analyticsQueries(db: Db, accountId: string) {
	const A = sql`${accountId}`;
	const scope = (domainId: number | null) => (domainId === null ? sql`` : sql`AND ar.domain_id = ${domainId}`);

	return {
		senderRows(domainId: number | null, since: number, now: number): Promise<SenderRow[]> {
			const horizon = now - FIRST_SEEN_HORIZON_DAYS * 86400;
			return db.all<SenderRow>(sql`
				SELECT
					rr.source_ip,
					d.id AS domain_id,
					d.domain,
					rr.header_from,
					rr.spf_domain,
					rr.spf_result,
					rr.dkim_domain,
					rr.dkim_result,
					SUM(CASE WHEN ar.date_begin >= ${since} THEN rr.count ELSE 0 END) AS messages,
					MIN(ar.date_begin) AS first_seen,
					MAX(ar.date_begin) AS last_seen,
					MAX(rr.reverse_dns) AS reverse_dns,
					MAX(rr.base_domain) AS base_domain,
					MAX(rr.org) AS org,
					MAX(rr.country_code) AS country_code
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				JOIN domains d ON d.id = ar.domain_id AND d.account_id = ${A}
				WHERE ar.account_id = ${A} AND rr.account_id = ${A}
				  AND ar.date_begin >= ${horizon} ${scope(domainId)}
				GROUP BY rr.source_ip, d.id, rr.header_from, rr.spf_domain, rr.spf_result, rr.dkim_domain, rr.dkim_result
				HAVING messages > 0
				ORDER BY messages DESC
			`);
		},

		/** Daily totals from the reports' own evaluated results (these are DMARC pass/fail, not derived). */
		trend(domainId: number | null, since: number): Promise<TrendRow[]> {
			return db.all<TrendRow>(sql`
				SELECT
					date(datetime(ar.date_begin, 'unixepoch')) AS day,
					SUM(ar.total_count) AS total,
					SUM(ar.pass_count)  AS passed,
					SUM(ar.fail_count)  AS failed
				FROM aggregate_reports ar
				JOIN domains d ON d.id = ar.domain_id AND d.account_id = ${A}
				WHERE ar.account_id = ${A} AND ar.date_begin >= ${since} ${scope(domainId)}
				GROUP BY day
				ORDER BY day ASC
			`);
		},

		/** Unix seconds of the earliest report in scope (within the horizon), or null when there are none. */
		async earliestReport(domainId: number | null, now: number): Promise<number | null> {
			const horizon = now - FIRST_SEEN_HORIZON_DAYS * 86400;
			const rows = await db.all<{ first: number | null }>(sql`
				SELECT MIN(ar.date_begin) AS first
				FROM aggregate_reports ar
				JOIN domains d ON d.id = ar.domain_id AND d.account_id = ${A}
				WHERE ar.account_id = ${A} AND ar.date_begin >= ${horizon} ${scope(domainId)}
			`);
			return rows[0]?.first ?? null;
		},

		/** Per-domain totals for the account-wide page (every domain listed, with zeros when it has no reports). */
		domainTotals(since: number) {
			return db.all<{ domain_id: number; domain: string; dmarc_policy: string | null; spf_record: string | null; total: number; passed: number; days_with_reports: number }>(sql`
				SELECT
					d.id AS domain_id,
					d.domain,
					d.dmarc_policy,
					d.spf_record,
					COALESCE(SUM(r.total_count), 0) AS total,
					COALESCE(SUM(r.pass_count), 0) AS passed,
					COUNT(DISTINCT date(datetime(r.date_begin, 'unixepoch'))) AS days_with_reports
				FROM domains d
				LEFT JOIN aggregate_reports r ON r.domain_id = d.id AND r.account_id = ${A} AND r.date_begin >= ${since}
				WHERE d.account_id = ${A}
				GROUP BY d.id, d.domain, d.dmarc_policy, d.spf_record
				ORDER BY d.domain
			`);
		},
	};
}
