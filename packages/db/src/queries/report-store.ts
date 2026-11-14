/**
 * Atomic storage of one aggregate report, built for D1's limits (https://developers.cloudflare.com/d1/platform/limits/):
 *   - the whole report is ONE `db.batch()`: one query against the 1,000 per invocation, and a transaction (a failing statement
 *     rolls the whole sequence back), so a report is stored with all its records or not at all;
 *   - records travel as JSON text in a bound parameter read by json_each(), not as one row of bound parameters each: a bound
 *     value may be 2,000,000 bytes and a statement 100,000 bytes, so the JSON is cut into chunks of at most JSON_PARAM_MAX_BYTES
 *     and every statement is a short fixed SQL text with 1–5 parameters.
 */
import { sql, type SQL } from 'drizzle-orm';

/** Largest JSON text bound to one statement. D1's limit is 2,000,000 bytes per string/value; we stay at half of it. */
export const JSON_PARAM_MAX_BYTES = 1_000_000;
/** Largest SQL text of one statement. D1's limit is 100,000 bytes. All ours are well under 5,000. */
export const SQL_MAX_BYTES = 100_000;

/** One stored record, in the column order of RECORD_COLUMNS. */
export type RecordTuple = [
	ip: string, count: number, disposition: string, dkimResult: string | null, dkimDomain: string | null,
	spfResult: string | null, spfDomain: string | null, headerFrom: string | null, reverseDns: string | null,
	baseDomain: string | null, countryCode: string | null, org: string | null,
];

const encoder = new TextEncoder();
export const byteLength = (s: string) => encoder.encode(s).length;

/** Cut rows into JSON arrays whose text is at most `maxBytes` UTF-8 bytes each (a single row is always far smaller). */
export function chunkJson(rows: readonly unknown[], maxBytes = JSON_PARAM_MAX_BYTES): string[] {
	const chunks: string[] = [];
	let parts: string[] = [];
	let size = 2; // [ ]
	for (const row of rows) {
		const text = JSON.stringify(row);
		const n = byteLength(text) + 1; // comma
		if (parts.length && size + n > maxBytes) {
			chunks.push('[' + parts.join(',') + ']');
			parts = [];
			size = 2;
		}
		parts.push(text);
		size += n;
	}
	if (parts.length) chunks.push('[' + parts.join(',') + ']');
	return chunks;
}

export interface StoreReportInput {
	workspaceId: string;
	domainId: number;
	report: {
		org_name: string; report_id: string; date_begin: number; date_end: number;
		total_count: number; pass_count: number; fail_count: number; raw_xml: string | null;
		reporter_auth: string | null; reporter_auth_domain: string | null; reporter_auth_reason: string | null;
	};
	records: RecordTuple[];
	/** Random id of this attempt (links the records to the row this batch inserted). */
	ingestToken: string;
	/** UTC day (YYYY-MM-DD) for the per-address stored-records counter. */
	day: string;
}

/** The statements of the storing batch, in order. Pure: nothing is run here. */
export function storeStatements(i: StoreReportInput): SQL[] {
	const r = i.report;
	const ws = i.workspaceId;
	const mine = sql`domain_id = ${i.domainId} AND report_id = ${r.report_id} AND ingest_token = ${i.ingestToken}`;
	const out: SQL[] = [
		sql`INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, raw_xml, workspace_id, reporter_auth, reporter_auth_domain, reporter_auth_reason, ingest_token, record_count)
			VALUES (${i.domainId}, ${r.org_name}, ${r.report_id}, ${r.date_begin}, ${r.date_end}, ${r.total_count}, ${r.pass_count}, ${r.fail_count}, ${r.raw_xml}, ${ws}, ${r.reporter_auth}, ${r.reporter_auth_domain}, ${r.reporter_auth_reason}, ${i.ingestToken}, ${i.records.length})
			ON CONFLICT DO NOTHING`,
	];
	for (const chunk of chunkJson(i.records)) {
		// The join on ingest_token yields no row when the report already existed (its token is another attempt's): a
		// re-delivery inserts nothing.
		out.push(sql`INSERT INTO report_records (report_id, workspace_id, source_ip, count, disposition, dkim_result, dkim_domain, spf_result, spf_domain, header_from, reverse_dns, base_domain, country_code, org)
			SELECT a.id, ${ws}, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'),
				json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), json_extract(j.value, '$[8]'), json_extract(j.value, '$[9]'), json_extract(j.value, '$[10]'), json_extract(j.value, '$[11]')
			FROM json_each(${chunk}) j JOIN (SELECT id FROM aggregate_reports WHERE workspace_id = ${ws} AND ${mine}) a`);
	}
	const exists = sql`EXISTS (SELECT 1 FROM aggregate_reports WHERE workspace_id = ${ws} AND ${mine})`;
	out.push(
		sql`INSERT INTO workspace_storage (workspace_id, reports, records) SELECT ${ws}, 1, ${i.records.length} WHERE ${exists}
			ON CONFLICT(workspace_id) DO UPDATE SET reports = reports + 1, records = records + excluded.records`,
		sql`INSERT INTO intake_quota (scope, day, records) SELECT ${'a:' + i.domainId}, ${i.day}, ${i.records.length} WHERE ${exists}
			ON CONFLICT(scope, day) DO UPDATE SET records = records + excluded.records`,
		// instance-wide stored records (STORED_ROW in intake.ts: scope '*', day 'total')
		sql`INSERT INTO intake_quota (scope, day, records) SELECT '*', 'total', ${i.records.length} WHERE ${exists}
			ON CONFLICT(scope, day) DO UPDATE SET records = records + excluded.records`,
	);
	return out;
}
