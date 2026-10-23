/**
 * Data-lifecycle queries that deliberately span every workspace: the daily retention sweeps, the
 * tombstones of failed Cloudflare revocations, and deleting a user's own login data. Like global.ts,
 * nothing here returns tenant data; it only removes it, by age.
 *
 * Deletes are batched (`rowid IN (SELECT rowid … LIMIT n)`) so no statement outgrows D1's limits, and
 * every sweep is idempotent: running it twice deletes nothing the second time.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
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
		purgeAggregateReports: (cutoff: number, limits: SweepLimits) =>
			loop(limits, async () => {
				spend(limits);
				const recs = changes(await db.run(sql`DELETE FROM report_records WHERE rowid IN (
					SELECT rowid FROM report_records WHERE report_id IN (SELECT id FROM aggregate_reports WHERE date_end < ${cutoff} OR created_at < ${cutoff}) LIMIT ${limits.recordBatch})`));
				if (recs >= limits.recordBatch) return { n: 0, more: true };
				if (limits.budget.left <= 0) return { n: 0, more: true };
				spend(limits);
				const n = changes(await db.run(sql`DELETE FROM aggregate_reports WHERE id IN (SELECT id FROM aggregate_reports WHERE date_end < ${cutoff} OR created_at < ${cutoff} ORDER BY id LIMIT ${limits.batch})`));
				return { n, more: n >= limits.batch };
			}),

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
