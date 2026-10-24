import { sql } from 'drizzle-orm';
import type { Db } from '../client';

export interface HeartbeatStats {
	domain_count: number;
	dns_verified_count: number;
	spf_flatten_count: number;
	mta_sts_testing_count: number;
	mta_sts_enforce_count: number;
	reports_30d: number;
	tls_reports_30d: number;
	team_member_count: number;
	instance_age_days: number;
}

/** Instance-wide counts for the opt-in telemetry heartbeat. */
export async function heartbeatStats(db: Db, workspaceId: string): Promise<HeartbeatStats> {
	const nowSec = Math.floor(Date.now() / 1000);
	const since30d = nowSec - 30 * 86400;
	const A = sql`${workspaceId}`;
	const one = async <T>(q: ReturnType<typeof sql>) => (await db.all<T>(q))[0];

	const [d, s, m, r, t, u, a] = await Promise.all([
		one<{ n: number; verified: number }>(sql`SELECT COUNT(*) AS n, SUM(CASE WHEN auth_record_provisioned = 1 THEN 1 ELSE 0 END) AS verified FROM domains WHERE workspace_id = ${A} AND evicted_at IS NULL`),
		one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM spf_flatten_config WHERE workspace_id = ${A} AND enabled = 1`),
		one<{ testing: number; enforce: number }>(sql`SELECT SUM(CASE WHEN mode = 'testing' THEN 1 ELSE 0 END) AS testing, SUM(CASE WHEN mode = 'enforce' THEN 1 ELSE 0 END) AS enforce FROM mta_sts_config WHERE workspace_id = ${A} AND enabled = 1`),
		one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM aggregate_reports WHERE workspace_id = ${A} AND created_at > ${since30d}`),
		one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM tls_reports WHERE workspace_id = ${A} AND created_at > ${since30d}`),
		one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ${A}`),
		one<{ first: number | null }>(sql`SELECT MIN(u.created_at) AS first FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id = ${A}`),
	]);

	const firstTs = a?.first ?? nowSec;
	return {
		domain_count: d?.n ?? 0,
		dns_verified_count: d?.verified ?? 0,
		spf_flatten_count: s?.n ?? 0,
		mta_sts_testing_count: m?.testing ?? 0,
		mta_sts_enforce_count: m?.enforce ?? 0,
		reports_30d: r?.n ?? 0,
		tls_reports_30d: t?.n ?? 0,
		team_member_count: u?.n ?? 0,
		instance_age_days: Math.floor((nowSec - firstTs) / 86400),
	};
}
