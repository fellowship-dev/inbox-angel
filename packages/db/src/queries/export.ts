/**
 * Everything one workspace holds, read for the owner's data export (a subject-access request).
 *
 * Columns are listed explicitly, never `SELECT *`: a column added to a table later is NOT exported (and could not leak)
 * until someone adds it to EXPORT_COLUMNS, or to EXPORT_EXCLUDED with the reason. test/lifecycle/export-columns.test.ts
 * fails when a table has a column in neither list.
 * Settings are an allow-list of known non-secret keys. Raw report XML/JSON is left out (it duplicates the parsed rows).
 * Big tables are read a keyset page at a time so the export can stream.
 */
import { sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';

type Row = Record<string, unknown>;

export const EXPORT_COLUMNS = {
	workspaces: ['id', 'name', 'created_at'],
	memberships: ['role', 'created_at'],
	users: ['id', 'email', 'name', 'last_login_at'],
	invites: ['email', 'role', 'invited_by', 'created_at', 'expires_at', 'used_at'],
	api_keys: ['id', 'user_id', 'name', 'prefix', 'created_at', 'last_used_at', 'expires_at', 'revoked_at'],
	settings: ['key', 'value', 'updated_at'],
	google_postmaster_connections: ['id', 'domain_id', 'status', 'last_attempt_at', 'last_success_at'],
	metric_observations: ['connection_id', 'domain_id', 'metric', 'period_start', 'period_end', 'source_id', 'payload'],
	cloudflare_connections: ['id', 'label', 'cf_account_id', 'cf_account_name', 'auth_type', 'scopes', 'status', 'status_detail', 'created_by', 'created_at', 'last_used_at'],
	domains: ['id', 'domain', 'rua_address', 'dmarc_policy', 'dmarc_pct', 'spf_record', 'auth_record_provisioned', 'created_at', 'updated_at', 'dns_record_id', 'rollout_rec_policy', 'rollout_rec_pct', 'parent_id', 'is_default', 'alerts_enabled', 'spf_lookup_count', 'cf_connection_id', 'verified_via', 'evicted_at', 'evicted_name'],
	aggregate_reports: ['id', 'domain_id', 'org_name', 'report_id', 'date_begin', 'date_end', 'total_count', 'pass_count', 'fail_count', 'created_at', 'reporter_auth', 'reporter_auth_domain'],
	report_records: ['id', 'report_id', 'source_ip', 'count', 'disposition', 'dkim_result', 'dkim_domain', 'spf_result', 'spf_domain', 'header_from', 'created_at', 'reverse_dns', 'base_domain', 'country_code', 'org'],
	tls_reports: ['id', 'domain_id', 'org_name', 'date_begin', 'date_end', 'total_success', 'total_failure', 'failure_details', 'created_at'],
	audit_log: ['id', 'actor_id', 'actor_email', 'actor_type', 'action', 'resource_type', 'resource_id', 'resource_name', 'before_value', 'after_value', 'meta', 'created_at'],
	monitor_subscriptions: ['id', 'email', 'domain', 'spf_record', 'dmarc_policy', 'dmarc_pct', 'dmarc_record', 'active', 'last_checked_at', 'created_at', 'confirmed_at'],
	spf_flatten_config: ['domain_id', 'enabled', 'cf_record_id', 'canonical_record', 'flattened_record', 'ip_count', 'lookup_count', 'last_flattened_at', 'last_error', 'created_at', 'updated_at'],
	mta_sts_config: ['domain_id', 'enabled', 'mode', 'mx_hosts', 'max_age', 'policy_id', 'mta_sts_record_id', 'tls_rpt_record_id', 'cname_record_id', 'last_error', 'created_at', 'updated_at'],
	hosted_domains: ['domain_id', 'hosted_id', 'zone_key', 'dmarc_record_id', 'spf_record_id', 'mta_sts_txt_record_id', 'mta_sts_host_record_id', 'tls_rpt_record_id', 'spf_source', 'dmarc_pointer', 'spf_pointer', 'mta_sts_pointer', 'tls_rpt_pointer', 'pointers_checked_at', 'created_at'],
} as const;

/** Columns deliberately not exported (secrets, other people's credentials, duplicates), or implied by the query (the workspace). */
export const EXPORT_EXCLUDED = {
	workspaces: [],
	memberships: ['workspace_id', 'user_id'],
	users: ['password_hash', 'role', 'session_token', 'created_at', 'email_verified', 'image', 'updated_at'],
	invites: ['token', 'workspace_id'],
	api_keys: ['workspace_id', 'key_hash'],
	settings: ['workspace_id'],
	google_postmaster_connections: ['workspace_id', 'token_envelope'],
	metric_observations: ['workspace_id'],
	cloudflare_connections: ['workspace_id', 'token_envelope'],
	domains: ['workspace_id'],
	aggregate_reports: ['workspace_id', 'raw_xml'],
	report_records: ['workspace_id'],
	tls_reports: ['workspace_id', 'raw_json'],
	audit_log: ['workspace_id'],
	monitor_subscriptions: ['workspace_id', 'session_token'],
	spf_flatten_config: ['workspace_id'],
	mta_sts_config: ['workspace_id'],
	hosted_domains: ['workspace_id'],
} as const;

/** Setting keys that hold no secret. Anything else (e.g. turnstile_secret_key) is not exported. */
export const EXPORT_SETTING_KEYS = [
	'base_domain', 'zone_id', 'zone_name', 'cf_account_id', 'reports_domain', 'from_email', 'workers_subdomain',
	'brand_logo_url', 'brand_color', 'custom_domain', 'telemetry_opted_in', 'turnstile_site_key',
] as const;

const C = (t: keyof typeof EXPORT_COLUMNS, alias?: string) => sql.raw(EXPORT_COLUMNS[t].map((c) => (alias ? `${alias}.${c}` : c)).join(', '));

export function exportQueries(dbLike: DbLike, workspaceId: string) {
	const db = getDb(dbLike);
	const all = (q: ReturnType<typeof sql>) => db.all(q) as Promise<Row[]>;
	const count = async (q: ReturnType<typeof sql>) => Number(((await db.all(q)) as Array<{ n: number }>)[0]?.n ?? 0);
	return {
		workspace: () => all(sql`SELECT ${C('workspaces')} FROM workspaces WHERE id = ${workspaceId}`),

		/** Rows in the big tables together: the export refuses workspaces past what one invocation can read. */
		async bigRowCount(): Promise<number> {
			const parts = await Promise.all([
				count(sql`SELECT COUNT(*) AS n FROM metric_observations WHERE workspace_id = ${workspaceId}`),
				count(sql`SELECT COUNT(*) AS n FROM report_records WHERE workspace_id = ${workspaceId}`),
				count(sql`SELECT COUNT(*) AS n FROM aggregate_reports WHERE workspace_id = ${workspaceId}`),
				count(sql`SELECT COUNT(*) AS n FROM tls_reports WHERE workspace_id = ${workspaceId}`),
				count(sql`SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ${workspaceId}`),
				count(sql`SELECT COUNT(*) AS n FROM domains WHERE workspace_id = ${workspaceId}`),
				count(sql`SELECT COUNT(*) AS n FROM monitor_subscriptions WHERE workspace_id = ${workspaceId}`),
			]);
			return parts.reduce((a, b) => a + b, 0);
		},

		/** Small tables, read whole. */
		small: {
			members: () =>
				all(sql`SELECT ${C('users', 'u')}, ${C('memberships', 'm')} FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ${workspaceId} ORDER BY m.created_at`),
			invites: () => all(sql`SELECT ${C('invites')} FROM invites WHERE workspace_id = ${workspaceId} ORDER BY created_at`),
			api_keys: () => all(sql`SELECT ${C('api_keys')} FROM api_keys WHERE workspace_id = ${workspaceId} ORDER BY created_at`),
			settings: () =>
				all(sql`SELECT ${C('settings')} FROM settings WHERE workspace_id = ${workspaceId} AND key IN (${sql.join(EXPORT_SETTING_KEYS.map((k) => sql`${k}`), sql`, `)}) ORDER BY key`),
			google_postmaster_connections: () => all(sql`SELECT ${C('google_postmaster_connections')} FROM google_postmaster_connections WHERE workspace_id = ${workspaceId} ORDER BY id`),
			cloudflare_connections: () => all(sql`SELECT ${C('cloudflare_connections')} FROM cloudflare_connections WHERE workspace_id = ${workspaceId} ORDER BY created_at`),
			spf_flatten_config: () => all(sql`SELECT ${C('spf_flatten_config')} FROM spf_flatten_config WHERE workspace_id = ${workspaceId} ORDER BY domain_id`),
			mta_sts_config: () => all(sql`SELECT ${C('mta_sts_config')} FROM mta_sts_config WHERE workspace_id = ${workspaceId} ORDER BY domain_id`),
			hosted_domains: () => all(sql`SELECT ${C('hosted_domains')} FROM hosted_domains WHERE workspace_id = ${workspaceId} ORDER BY domain_id`),
		},

		/** Large tables: rows with id > `after`, ascending. */
		paged: {
			// SQLite rowid is an export cursor only; provider identity is source_id plus metric/period.
			metric_observations: (after: number, limit: number) => all(sql`SELECT rowid AS id, ${C('metric_observations')} FROM metric_observations WHERE workspace_id = ${workspaceId} AND rowid > ${after} ORDER BY rowid LIMIT ${limit}`),
			domains: (after: number, limit: number) => all(sql`SELECT ${C('domains')} FROM domains WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			aggregate_reports: (after: number, limit: number) => all(sql`SELECT ${C('aggregate_reports')} FROM aggregate_reports WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			report_records: (after: number, limit: number) => all(sql`SELECT ${C('report_records')} FROM report_records WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			tls_reports: (after: number, limit: number) => all(sql`SELECT ${C('tls_reports')} FROM tls_reports WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			audit_log: (after: number, limit: number) => all(sql`SELECT ${C('audit_log')} FROM audit_log WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			monitor_subscriptions: (after: number, limit: number) => all(sql`SELECT ${C('monitor_subscriptions')} FROM monitor_subscriptions WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
		},
	};
}
