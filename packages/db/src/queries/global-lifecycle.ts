/**
 * Data-lifecycle queries that deliberately span every workspace: the daily retention sweeps, the
 * tombstones of failed Cloudflare revocations, and deleting a user's own login data. Like global.ts,
 * nothing here returns tenant data; it only removes it, by age.
 *
 * Deletes are batched (`rowid IN (SELECT rowid … LIMIT n)`) so no statement outgrows D1's limits, and
 * every sweep is idempotent: running it twice deletes nothing the second time.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { batchStatements, getDb, type DbLike } from '../client';
import { STORED_ROW, UNCOUNTED_ROW } from './intake';
import { apiKeys, auditLog, authAccounts, invites, memberships, passwordResetTokens, sessions, users, verifications } from '../schema';

const changes = (res: unknown): number => Number((res as any)?.meta?.changes ?? (res as any)?.changes ?? 0);

/** Statements one retention run may issue in total, across every sweep (D1 caps queries per invocation). */
export const DEFAULT_STATEMENT_BUDGET = 300;

export interface SweepLimits {
	/** Rows (reports, for the report tables) per statement. */
	batch: number;
	/** Records deleted per statement when purging reports. */
	recordBatch: number;
	/** Statements still allowed in this run. Shared by every sweep that is handed the same object; each statement spends one. */
	budget: { left: number };
}

export const sweepLimits = (o: Partial<Omit<SweepLimits, 'budget'>> & { statements?: number } = {}): SweepLimits => ({
	batch: o.batch ?? 500,
	recordBatch: o.recordBatch ?? 1000,
	budget: { left: o.statements ?? DEFAULT_STATEMENT_BUDGET },
});

export interface SweepResult { deleted: number; truncated: boolean }

export interface Tombstone {
	id: string;
	deleted_workspace_id: string;
	connection_id: string;
	cf_account_id: string | null;
	/** The sealed grant (token_envelope), for a retry. */
	sealed_grant: string;
	attempts: number;
	last_error: string | null;
	last_attempt_at: number | null;
	created_at: number;
}

export function lifecycleQueries(dbLike: DbLike) {
	const db = getDb(dbLike);

	/**
	 * Run `step` until it reports the table is clean or the shared statement budget is spent.
	 * `step` returns the rows it deleted (counted) and whether more are probably waiting.
	 */
	async function loop(limits: SweepLimits, step: () => Promise<{ n: number; more: boolean }>): Promise<SweepResult> {
		let deleted = 0;
		while (limits.budget.left > 0) {
			const r = await step();
			deleted += r.n;
			if (!r.more) return { deleted, truncated: false };
		}
		return { deleted, truncated: true };
	}
	const spend = (limits: SweepLimits) => { limits.budget.left--; };
	/** Rows a sweep deleted, per workspace and budget: counted (and legacy) or uncounted (tier unknown/unauthenticated). */
	type Gone = Map<string, { records: number; reports: number; uRecords: number; uReports: number }>;
	const bump = (m: Gone, w: string) => { let g = m.get(w); if (!g) m.set(w, (g = { records: 0, reports: 0, uRecords: 0, uReports: 0 })); return g; };
	/** Keep workspace_storage and the two instance totals in step with rows a sweep deleted (one batch; its budget statement was held back). */
	async function settleStorage(per: Gone): Promise<void> {
		let records = 0;
		let uRecords = 0;
		for (const g of per.values()) { records += g.records; uRecords += g.uRecords; }
		await batchStatements(db, [
			...[...per].map(([w, n]) => sql`UPDATE workspace_storage SET records = MAX(0, records - ${n.records}), reports = MAX(0, reports - ${n.reports}), uncounted_records = MAX(0, uncounted_records - ${n.uRecords}), uncounted_reports = MAX(0, uncounted_reports - ${n.uReports}) WHERE workspace_id = ${w}`),
			...(records ? [sql`UPDATE intake_quota SET records = MAX(0, records - ${records}) WHERE scope = ${STORED_ROW.scope} AND day = ${STORED_ROW.day}`] : []),
			...(uRecords ? [sql`UPDATE intake_quota SET records = MAX(0, records - ${uRecords}) WHERE scope = ${UNCOUNTED_ROW.scope} AND day = ${UNCOUNTED_ROW.day}`] : []),
		]);
	}
	/** One bounded statement per step (the common case). */
	const simple = (limits: SweepLimits, run: () => Promise<unknown>) =>
		loop(limits, async () => {
			spend(limits);
			const n = changes(await run());
			return { n, more: n >= limits.batch };
		});

	return {
		/**
		 * Aggregate reports past their window, and their records. Records go first, a bounded number per statement by rowid
		 * (one report can hold hundreds of thousands); the reports follow once theirs are gone. Returns reports deleted.
		 */
		purgeAggregateReports: async (cutoff: number, limits: SweepLimits, uncountedCutoff?: number): Promise<SweepResult> => {
			// Past the report window, or (when given) an uncounted-tier report (unknown or unauthenticated) older than its own, shorter, retention.
			// A reporter an owner promotes becomes tier 'counted' and is no longer matched by the second clause.
			const old = uncountedCutoff === undefined
				? sql`(date_end < ${cutoff} OR created_at < ${cutoff})`
				: sql`(date_end < ${cutoff} OR created_at < ${cutoff} OR (reporter_tier IN ('unknown', 'unauthenticated') AND created_at < ${uncountedCutoff}))`;
			// One statement of the budget is held back for keeping workspace_storage in step with what was deleted (one batch per run).
			if (limits.budget.left < 2) return { deleted: 0, truncated: true };
			spend(limits);
			const gone: Gone = new Map();
			// Counters are given back when the REPORT row goes (its records are deleted first, a bounded number per statement): by its record_count, or for a
			// row stored before 0010 (NULL) by the records this run deleted for it. The budget is the report's tier: uncounted (unknown/unauthenticated) or not.
			const removed = new Map<number, number>();
			const result = await loop(limits, async () => {
				spend(limits);
				const recs = await db.all<{ report_id: number }>(sql`DELETE FROM report_records WHERE rowid IN (
					SELECT rowid FROM report_records WHERE report_id IN (SELECT id FROM aggregate_reports WHERE ${old}) LIMIT ${limits.recordBatch}) RETURNING report_id`);
				for (const r of recs) removed.set(r.report_id, (removed.get(r.report_id) ?? 0) + 1);
				if (recs.length >= limits.recordBatch) return { n: 0, more: true };
				if (limits.budget.left <= 0) return { n: 0, more: true };
				spend(limits);
				const reps = await db.all<{ id: number; workspace_id: string; unc: number; record_count: number | null }>(sql`DELETE FROM aggregate_reports WHERE id IN (SELECT id FROM aggregate_reports WHERE ${old} ORDER BY id LIMIT ${limits.batch})
					RETURNING id, workspace_id, COALESCE(reporter_tier, '') IN ('unknown', 'unauthenticated') AS unc, record_count`);
				for (const r of reps) {
					const g = bump(gone, r.workspace_id);
					const records = r.record_count ?? removed.get(r.id) ?? 0;
					if (r.unc) { g.uReports++; g.uRecords += records; } else { g.reports++; g.records += records; }
				}
				return { n: reps.length, more: reps.length >= limits.batch };
			});
			if (gone.size) await settleStorage(gone);
			else limits.budget.left++; // nothing deleted: the held-back statement was not needed
			return result;
		},

		/**
		 * Intake counters of days before `cutoffDay` (YYYY-MM-DD): the per-reporter usage, the per-scope quota (its 'total' row is
		 * not a date and is never matched) and, with its own longer cutoff, the failure markers the owner reads.
		 */
		purgeIntakeCounters: async (cutoffDay: string, limits: SweepLimits): Promise<SweepResult> => {
			const a = await simple(limits, () => db.run(sql`DELETE FROM intake_usage WHERE rowid IN (SELECT rowid FROM intake_usage WHERE day < ${cutoffDay} LIMIT ${limits.batch})`));
			const b = await simple(limits, () => db.run(sql`DELETE FROM intake_quota WHERE rowid IN (SELECT rowid FROM intake_quota WHERE day < ${cutoffDay} AND day <> ${STORED_ROW.day} LIMIT ${limits.batch})`));
			return { deleted: a.deleted + b.deleted, truncated: a.truncated || b.truncated };
		},
		/** Registry-candidate rows older than `cutoffDay`. */
		purgeReporterCandidates: (cutoffDay: string, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM reporter_candidate_days WHERE rowid IN (SELECT rowid FROM reporter_candidate_days WHERE day < ${cutoffDay} LIMIT ${limits.batch})`)),

		/** "Reports from X were not stored" markers whose last drop is before `cutoff` (unix seconds): nothing dropped since, the state is stale. */
		purgeIntakeDrops: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM intake_drops WHERE rowid IN (SELECT rowid FROM intake_drops WHERE last_at < ${cutoff} LIMIT ${limits.batch})`)),

		purgeIntakeFailures: (cutoffDay: string, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM intake_failures WHERE rowid IN (SELECT rowid FROM intake_failures WHERE day < ${cutoffDay} LIMIT ${limits.batch})`)),

		/**
		 * Recount what workspaces hold (workspace_storage and the instance total) for up to `workspaces` of them, least recently
		 * recounted first: the live counters move with every store and purge, this repairs any drift (and counts data stored before 0010).
		 */
		reconcileStorage: async (limits: SweepLimits, workspaces = 5): Promise<SweepResult> => {
			if (limits.budget.left < 3) return { deleted: 0, truncated: true }; // three statements: pick, recount, instance total
			spend(limits);
			const due = await db.all<{ id: string }>(sql`SELECT w.id AS id FROM workspaces w LEFT JOIN workspace_storage s ON s.workspace_id = w.id ORDER BY s.reconciled_at IS NOT NULL, s.reconciled_at, w.id LIMIT ${workspaces}`);
			if (!due.length) return { deleted: 0, truncated: false };
			spend(limits);
			// Uncounted figures come from aggregate_reports.record_count (every uncounted report was stored by 0010 or later, so it is set): no join over report_records.
			await batchStatements(db, due.map(({ id }) => sql`INSERT INTO workspace_storage (workspace_id, reports, records, uncounted_reports, uncounted_records, reconciled_at)
				SELECT ${id},
					(SELECT COUNT(*) FROM aggregate_reports WHERE workspace_id = ${id} AND COALESCE(reporter_tier, '') NOT IN ('unknown', 'unauthenticated')),
					(SELECT COUNT(*) FROM report_records WHERE workspace_id = ${id}) - (SELECT COALESCE(SUM(record_count), 0) FROM aggregate_reports WHERE workspace_id = ${id} AND reporter_tier IN ('unknown', 'unauthenticated')),
					(SELECT COUNT(*) FROM aggregate_reports WHERE workspace_id = ${id} AND reporter_tier IN ('unknown', 'unauthenticated')),
					(SELECT COALESCE(SUM(record_count), 0) FROM aggregate_reports WHERE workspace_id = ${id} AND reporter_tier IN ('unknown', 'unauthenticated')), unixepoch() WHERE true
				ON CONFLICT(workspace_id) DO UPDATE SET reports = excluded.reports, records = MAX(0, excluded.records), uncounted_reports = excluded.uncounted_reports, uncounted_records = excluded.uncounted_records, reconciled_at = excluded.reconciled_at`));
			spend(limits);
			await batchStatements(db, [
				sql`INSERT INTO intake_quota (scope, day, records) SELECT ${STORED_ROW.scope}, ${STORED_ROW.day}, COALESCE(SUM(records), 0) FROM workspace_storage WHERE true
					ON CONFLICT(scope, day) DO UPDATE SET records = excluded.records`,
				sql`INSERT INTO intake_quota (scope, day, records) SELECT ${UNCOUNTED_ROW.scope}, ${UNCOUNTED_ROW.day}, COALESCE(SUM(uncounted_records), 0) FROM workspace_storage WHERE true
					ON CONFLICT(scope, day) DO UPDATE SET records = excluded.records`,
			]);
			return { deleted: 0, truncated: false }; // a recount deletes nothing (the sweeps report rows deleted)
		},

		purgeTlsReports: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM tls_reports WHERE id IN (SELECT id FROM tls_reports WHERE date_end < ${cutoff} OR created_at < ${cutoff} ORDER BY id LIMIT ${limits.batch})`)),

		/** Drop the raw XML of reports stored before `cutoff`; the parsed rows stay. */
		clearRawXml: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`UPDATE aggregate_reports SET raw_xml = NULL WHERE id IN (SELECT id FROM aggregate_reports WHERE raw_xml IS NOT NULL AND created_at < ${cutoff} ORDER BY created_at LIMIT ${limits.batch})`)),

		clearTlsRaw: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`UPDATE tls_reports SET raw_json = NULL WHERE id IN (SELECT id FROM tls_reports WHERE raw_json IS NOT NULL AND created_at < ${cutoff} ORDER BY created_at LIMIT ${limits.batch})`)),

		purgeIpInfo: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM ip_info WHERE ip IN (SELECT ip FROM ip_info WHERE fetched_at < ${cutoff} LIMIT ${limits.batch})`)),

		purgeCheckResults: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM check_results WHERE id IN (SELECT id FROM check_results WHERE created_at < ${cutoff} LIMIT ${limits.batch})`)),

		/** Sessions that expired before `now` (unix seconds). */
		purgeSessions: (now: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ${now} LIMIT ${limits.batch})`)),

		purgeVerifications: (now: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM verifications WHERE id IN (SELECT id FROM verifications WHERE expires_at < ${now} LIMIT ${limits.batch})`)),

		purgeResetTokens: (now: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM password_reset_tokens WHERE token IN (SELECT token FROM password_reset_tokens WHERE expires_at < ${now} LIMIT ${limits.batch})`)),

		/** Invites that expired before `cutoff` (used or not). */
		purgeInvites: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM invites WHERE token IN (SELECT token FROM invites WHERE expires_at < ${cutoff} LIMIT ${limits.batch})`)),

		/** Domains evicted before `cutoff` (30 days): their reports go with them (cascade). */
		purgeEvictedDomains: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM domains WHERE id IN (SELECT id FROM domains WHERE evicted_at IS NOT NULL AND evicted_at < ${cutoff} LIMIT ${limits.batch})`)),

		/** Claims that became domains before `cutoff`: they were kept a day for a repeat verify. */
		purgeSettledClaims: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM domain_claims WHERE id IN (SELECT id FROM domain_claims WHERE settled_at IS NOT NULL AND settled_at < ${cutoff} LIMIT ${limits.batch})`)),

		purgeAudit: (cutoff: number, limits: SweepLimits) =>
			simple(limits, () => db.run(sql`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ${cutoff} LIMIT ${limits.batch})`)),

		tombstones: {
			add: (t: { id: string; deleted_workspace_id: string; connection_id: string; cf_account_id: string | null; sealed_grant: string; last_error: string | null }) =>
				db.run(sql`INSERT INTO revocation_tombstones (id, deleted_workspace_id, connection_id, cf_account_id, token_envelope, last_error, attempts, last_attempt_at)
					VALUES (${t.id}, ${t.deleted_workspace_id}, ${t.connection_id}, ${t.cf_account_id}, ${t.sealed_grant}, ${t.last_error}, 1, unixepoch())`),
			list: (limit = 100) =>
				db.all(sql`SELECT id, deleted_workspace_id, connection_id, cf_account_id, token_envelope AS sealed_grant, attempts, last_error, last_attempt_at, created_at FROM revocation_tombstones ORDER BY created_at LIMIT ${limit}`) as Promise<Tombstone[]>,
			failed: (id: string, error: string) =>
				db.run(sql`UPDATE revocation_tombstones SET attempts = attempts + 1, last_error = ${error}, last_attempt_at = unixepoch() WHERE id = ${id}`),
			delete: (id: string) => db.run(sql`DELETE FROM revocation_tombstones WHERE id = ${id}`),
		},

		/**
		 * Remove a user's own data: login methods, sessions, tokens, API keys, memberships, invites sent to their
		 * address, and the email in the audit trail (the entries stay, pseudonymised). The caller has already dealt with
		 * workspaces they solely own. Statement order matters only for readability: each is independent.
		 */
		async deleteUser(userId: string, email: string): Promise<void> {
			await db.batch([
				db.update(auditLog).set({ actor_email: null }).where(eq(auditLog.actor_id, userId)),
				db.update(auditLog).set({ resource_name: null }).where(and(eq(auditLog.resource_type, 'user'), eq(auditLog.resource_id, userId))),
				db.delete(invites).where(or(sql`lower(${invites.email}) = lower(${email})`, and(isNull(invites.used_at), sql`lower(${invites.invited_by}) = lower(${email})`))),
				db.delete(verifications).where(or(eq(verifications.value, userId), sql`lower(${verifications.identifier}) = lower(${email})`)),
				db.delete(passwordResetTokens).where(eq(passwordResetTokens.user_id, userId)),
				db.delete(apiKeys).where(eq(apiKeys.user_id, userId)),
				db.delete(sessions).where(eq(sessions.userId, userId)),
				db.delete(authAccounts).where(eq(authAccounts.userId, userId)),
				db.delete(memberships).where(eq(memberships.user_id, userId)),
				db.delete(users).where(eq(users.id, userId)),
			]);
		},
	};
}
