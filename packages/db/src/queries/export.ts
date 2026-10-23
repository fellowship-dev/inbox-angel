/**
 * Everything one workspace holds, read for the owner's data export (a subject-access request).
 *
 * Secrets are never selected: no password hashes, invite or session tokens, API-key hashes, sealed
 * Cloudflare tokens or `*secret*`/`*token*` settings. Raw report XML/JSON is left out too (it duplicates
 * the parsed rows). Big tables are read a keyset page at a time so the export can stream.
 */
import { sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';

type Row = Record<string, unknown>;

export function exportQueries(dbLike: DbLike, workspaceId: string) {
	const db = getDb(dbLike);
	const all = (q: ReturnType<typeof sql>) => db.all(q) as Promise<Row[]>;
	return {
		workspace: () => all(sql`SELECT id, name, created_at FROM workspaces WHERE id = ${workspaceId}`),

		/** Small tables, read whole. */
		small: {
			members: () =>
				all(sql`SELECT u.id, u.email, u.name, m.role, m.created_at AS member_since, u.last_login_at
					FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ${workspaceId} ORDER BY m.created_at`),
			invites: () => all(sql`SELECT email, role, invited_by, created_at, expires_at, used_at FROM invites WHERE workspace_id = ${workspaceId} ORDER BY created_at`),
			api_keys: () => all(sql`SELECT id, user_id, name, prefix, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE workspace_id = ${workspaceId} ORDER BY created_at`),
			settings: () =>
				all(sql`SELECT key, value, updated_at FROM settings WHERE workspace_id = ${workspaceId} AND key NOT LIKE '%secret%' AND key NOT LIKE '%token%' ORDER BY key`),
			cloudflare_connections: () =>
				all(sql`SELECT id, label, cf_account_id, cf_account_name, auth_type, scopes, status, status_detail, created_by, created_at, last_used_at
					FROM cloudflare_connections WHERE workspace_id = ${workspaceId} ORDER BY created_at`),
			spf_flatten_config: () => all(sql`SELECT * FROM spf_flatten_config WHERE workspace_id = ${workspaceId} ORDER BY domain_id`),
			mta_sts_config: () => all(sql`SELECT * FROM mta_sts_config WHERE workspace_id = ${workspaceId} ORDER BY domain_id`),
			hosted_domains: () => all(sql`SELECT * FROM hosted_domains WHERE workspace_id = ${workspaceId} ORDER BY domain_id`),
		},

		/** Large tables: rows with id > `after`, ascending. */
		paged: {
			domains: (after: number, limit: number) => all(sql`SELECT * FROM domains WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			aggregate_reports: (after: number, limit: number) =>
				all(sql`SELECT id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, created_at
					FROM aggregate_reports WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			report_records: (after: number, limit: number) =>
				all(sql`SELECT * FROM report_records WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			tls_reports: (after: number, limit: number) =>
				all(sql`SELECT id, domain_id, org_name, date_begin, date_end, total_success, total_failure, failure_details, created_at
					FROM tls_reports WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			audit_log: (after: number, limit: number) => all(sql`SELECT * FROM audit_log WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
			monitor_subscriptions: (after: number, limit: number) =>
				all(sql`SELECT id, email, domain, spf_record, dmarc_policy, dmarc_pct, dmarc_record, active, last_checked_at, created_at
					FROM monitor_subscriptions WHERE workspace_id = ${workspaceId} AND id > ${after} ORDER BY id LIMIT ${limit}`),
		},
	};
}
