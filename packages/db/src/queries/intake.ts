/**
 * Hosted (SaaS) intake: per-domain report tokens and the records a domain has in the operator's
 * hosted-records zone. `intakeLookups` is the one place that runs before the workspace is known:
 * it turns a token (from an inbound address) or a hosted id (from a policy hostname) into the
 * workspace and domain it belongs to, and returns nothing else.
 */
import { and, count, eq, isNull, gt, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { batchStatements, getDb, type DbLike } from '../client';
import { domains, hostedDomains, intakeTokens, intakeUsage } from '../schema';

/** How long the previous token keeps working after a rotation (receivers cache the rua address). */
export const TOKEN_ROTATION_GRACE_SECONDS = 72 * 3600;

/** Scope and day of the instance-wide count of stored records (intake_quota): `day` is not a date, so no daily sweep matches it. */
export const STORED_ROW = { scope: '*', day: 'total' } as const;

export interface QuotaLimits {
	/** Messages per UTC day to one report address (domain). */
	address: number;
	/** Messages per UTC day to one workspace. */
	workspace: number;
	/** Messages per UTC day to the whole instance. */
	instance: number;
	/** Messages from authenticated reporters we do not know, per UTC day to one address, over every such reporter. */
	unknownTotal: number;
}
export type QuotaScope = 'address' | 'unknown' | 'workspace' | 'instance';
export interface QuotaResult {
	ok: boolean;
	/** The first cap that refused the message (nothing was counted then). */
	refusedBy?: QuotaScope;
	/** Stored records counted so far today for this address, for this workspace, and for the instance (live rows, not per day). */
	addressRecordsToday: number;
	workspaceRecords: number;
	instanceRecords: number;
}
export interface FailureRow { reason: string; messages: number; last_at: number }

/** The usage row that totals, per token and day, what reporters with no standing (not well known) have used. */
export const TOTAL_ROW = '*';

export function intakeQueries(db: Db, workspaceId: string) {
	const mine = eq(intakeTokens.workspace_id, workspaceId);
	const forDomain = (id: number) => and(mine, eq(intakeTokens.domain_id, id));
	const mine_usage = () => eq(intakeUsage.workspace_id, workspaceId);

	return {
		get(domainId: number) {
			return db.select().from(intakeTokens).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		/**
		 * Set the token hash of a domain. The first call creates the row; later calls rotate: the old hash
		 * stays valid for TOKEN_ROTATION_GRACE_SECONDS.
		 */
		set(domainId: number, tokenHash: string, nowSeconds: number) {
			return db
				.insert(intakeTokens)
				.values({ domain_id: domainId, workspace_id: workspaceId, token_hash: tokenHash })
				.onConflictDoUpdate({
					target: intakeTokens.domain_id,
					// An upsert must never move a row to another workspace.
					setWhere: mine,
					set: {
						prev_token_hash: sql`${intakeTokens.token_hash}`,
						prev_expires_at: nowSeconds + TOKEN_ROTATION_GRACE_SECONDS,
						token_hash: sql`excluded.token_hash`,
						rotated_at: nowSeconds,
					},
				})
				.run();
		},

		/**
		 * Count one report of `bytes` against the allowance of (domain, `day` (YYYY-MM-DD, UTC), `reporter`), where `reporter` is the
		 * authenticated sending organisation's domain. One atomic conditional upsert: nothing is counted (and false is returned) when it
		 * would exceed `maxReports` or `maxBytes`. A reporter's allowance is its own: another reporter cannot use it up.
		 */
		async consumeReporter(domainId: number, day: string, reporter: string, bytes: number, maxReports: number, maxBytes: number): Promise<boolean> {
			if (maxReports < 1 || bytes > maxBytes) return false;
			const res = await db
				.insert(intakeUsage)
				.values({ domain_id: domainId, workspace_id: workspaceId, day, reporter, reports: 1, bytes })
				.onConflictDoUpdate({
					target: [intakeUsage.domain_id, intakeUsage.day, intakeUsage.reporter],
					setWhere: and(eq(intakeUsage.workspace_id, workspaceId), lt(intakeUsage.reports, maxReports), sql`${intakeUsage.bytes} + ${bytes} <= ${maxBytes}`),
					set: { reports: sql`${intakeUsage.reports} + 1`, bytes: sql`${intakeUsage.bytes} + ${bytes}` },
				})
				.run();
			return (res.meta?.changes ?? 0) > 0;
		},

		/** Give back one report counted by consumeReporter (a later check refused the message). */
		releaseReporter(domainId: number, day: string, reporter: string, bytes: number) {
			return db.update(intakeUsage).set({ reports: sql`MAX(0, ${intakeUsage.reports} - 1)`, bytes: sql`MAX(0, ${intakeUsage.bytes} - ${bytes})` })
				.where(and(eq(intakeUsage.workspace_id, workspaceId), eq(intakeUsage.domain_id, domainId), eq(intakeUsage.day, day), eq(intakeUsage.reporter, reporter))).run();
		},

		/**
		 * Count one message against the address, workspace and instance daily caps (and, for an unknown reporter, the address's unknown-reporter
		 * total) in ONE batch: each is a conditional upsert that counts nothing once its cap is reached. When any refuses, the ones that
		 * counted are given back (a second batch). Also returns the stored-records figures the post-parse checks need.
		 */
		async consumeQuota(domainId: number, day: string, bytes: number, unknownReporter: boolean, lim: QuotaLimits): Promise<QuotaResult> {
			const scopes: Array<[QuotaScope, string, number]> = [['address', `a:${domainId}`, lim.address], ['workspace', `w:${workspaceId}`, lim.workspace], ['instance', '*', lim.instance]];
			if (unknownReporter) scopes.splice(1, 0, ['unknown', `k:${domainId}`, lim.unknownTotal]);
			const up = (scope: string, max: number) => sql`INSERT INTO intake_quota (scope, day, messages, bytes) VALUES (${scope}, ${day}, 1, ${bytes})
				ON CONFLICT(scope, day) DO UPDATE SET messages = intake_quota.messages + 1, bytes = intake_quota.bytes + excluded.bytes WHERE intake_quota.messages < ${max}`;
			const res = await batchStatements(db, [
				...scopes.map(([, scope, max]) => up(scope, max)),
				sql`SELECT records FROM intake_quota WHERE scope = ${'a:' + domainId} AND day = ${day}`,
				sql`SELECT records FROM workspace_storage WHERE workspace_id = ${workspaceId}`,
				sql`SELECT records FROM intake_quota WHERE scope = ${STORED_ROW.scope} AND day = ${STORED_ROW.day}`,
			]);
			const n = scopes.length;
			const counted = scopes.map((_, i) => (res[i]?.meta?.changes ?? 0) > 0);
			const rec = (i: number) => Number(((res[n + i]?.results ?? []) as Array<{ records: number }>)[0]?.records ?? 0);
			const figures = { addressRecordsToday: rec(0), workspaceRecords: rec(1), instanceRecords: rec(2) };
			const refused = counted.findIndex((c) => !c);
			if (refused < 0) return { ok: true, ...figures };
			await this.releaseQuota(domainId, day, bytes, scopes.filter((_, i) => counted[i]).map(([, scope]) => scope));
			return { ok: false, refusedBy: scopes[refused][0], ...figures };
		},

		/** Give back what consumeQuota counted for a message that was then refused by a later check. `scopes` default: all four. */
		async releaseQuota(domainId: number, day: string, bytes: number, scopes: string[] = [`a:${domainId}`, `k:${domainId}`, `w:${workspaceId}`, '*']): Promise<void> {
			if (!scopes.length) return;
			await batchStatements(db, scopes.map((scope) => sql`UPDATE intake_quota SET messages = MAX(0, messages - 1), bytes = MAX(0, bytes - ${bytes}) WHERE scope = ${scope} AND day = ${day}`));
		},

		/** Count one message that reached this address and was not stored (visible to the owner). Returns today's count for the reason. */
		async markFailure(domainId: number, day: string, reason: string, nowSeconds: number): Promise<number> {
			const rows = await db.all<{ messages: number }>(sql`INSERT INTO intake_failures (domain_id, workspace_id, day, reason, messages, last_at)
				VALUES (${domainId}, ${workspaceId}, ${day}, ${reason}, 1, ${nowSeconds})
				ON CONFLICT(domain_id, day, reason) DO UPDATE SET messages = intake_failures.messages + 1, last_at = excluded.last_at WHERE intake_failures.workspace_id = ${workspaceId}
				RETURNING messages`);
			return rows[0]?.messages ?? 0;
		},

		/** Messages that reached this address since `sinceDay` (YYYY-MM-DD) and were not stored, per reason. */
		failures(domainId: number, sinceDay: string): Promise<FailureRow[]> {
			return db.all<FailureRow>(sql`SELECT reason, SUM(messages) AS messages, MAX(last_at) AS last_at FROM intake_failures
				WHERE workspace_id = ${workspaceId} AND domain_id = ${domainId} AND day >= ${sinceDay} GROUP BY reason ORDER BY last_at DESC`);
		},

		/** Today's counters for an address and its workspace, and the stored records, for the owner-visible state. */
		async usage(domainId: number, day: string) {
			const [q, st, inst] = await Promise.all([
				db.all<{ scope: string; messages: number; records: number }>(sql`SELECT scope, messages, records FROM intake_quota WHERE day = ${day} AND scope IN (${'a:' + domainId}, ${'w:' + workspaceId})`),
				db.all<{ records: number }>(sql`SELECT records FROM workspace_storage WHERE workspace_id = ${workspaceId}`),
				db.all<{ records: number }>(sql`SELECT records FROM intake_quota WHERE scope = ${STORED_ROW.scope} AND day = ${STORED_ROW.day}`),
			]);
			const by = (scope: string) => q.find((r) => r.scope === scope);
			return {
				addressMessagesToday: by(`a:${domainId}`)?.messages ?? 0,
				workspaceMessagesToday: by(`w:${workspaceId}`)?.messages ?? 0,
				workspaceRecords: st[0]?.records ?? 0,
				instanceRecords: inst[0]?.records ?? 0,
			};
		},

		delete(domainId: number) {
			return db.delete(intakeTokens).where(forDomain(domainId)).run();
		},
	};
}

export type HostedDomainRow = typeof hostedDomains.$inferSelect;
export type PointerStatus = 'ok' | 'missing' | 'wrong' | 'error';

export function hostedQueries(db: Db, workspaceId: string) {
	const mine = eq(hostedDomains.workspace_id, workspaceId);
	const forDomain = (id: number) => and(mine, eq(hostedDomains.domain_id, id));

	return {
		get(domainId: number) {
			return db.select().from(hostedDomains).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		list() {
			return db.select().from(hostedDomains).where(mine).all();
		},

		/** How many domains of this workspace use hosted records. */
		count() {
			return db.select({ n: count() }).from(hostedDomains).where(mine).get().then((r) => r?.n ?? 0);
		},

		insert(h: { domain_id: number; hosted_id: string; zone_key: string; spf_source?: string | null }) {
			return db.insert(hostedDomains).values({ ...h, workspace_id: workspaceId }).run();
		},

		setRecords(domainId: number, ids: { dmarc_record_id?: string | null; spf_record_id?: string | null; mta_sts_txt_record_id?: string | null; mta_sts_host_record_id?: string | null; tls_rpt_record_id?: string | null; spf_source?: string | null }) {
			return db.update(hostedDomains).set(ids).where(forDomain(domainId)).run();
		},

		setPointers(domainId: number, p: { dmarc_pointer: PointerStatus; spf_pointer: PointerStatus; mta_sts_pointer: PointerStatus; tls_rpt_pointer: PointerStatus }, nowSeconds: number) {
			return db.update(hostedDomains).set({ ...p, pointers_checked_at: nowSeconds }).where(forDomain(domainId)).run();
		},

		delete(domainId: number) {
			return db.delete(hostedDomains).where(forDomain(domainId)).run();
		},
	};
}

export interface IntakeTarget { workspace_id: string; domain_id: number; domain: string }

export function intakeLookups(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** The domain a token (as hashed from an inbound address) belongs to: the current token, or the previous one within its grace. */
		resolveToken: (tokenHash: string, nowSeconds: number): Promise<IntakeTarget | null> =>
			db
				.select({ workspace_id: intakeTokens.workspace_id, domain_id: intakeTokens.domain_id, domain: domains.domain })
				.from(intakeTokens)
				.innerJoin(domains, and(eq(domains.id, intakeTokens.domain_id), isNull(domains.evicted_at)))
				.where(
					/* workspace-scope-exempt: the token hash identifies the workspace */
					or(eq(intakeTokens.token_hash, tokenHash), and(eq(intakeTokens.prev_token_hash, tokenHash), gt(intakeTokens.prev_expires_at, nowSeconds))),
				)
				.get()
				.then((r) => r ?? null),

		/** The domain behind an opaque hosted id (the label in `mta-sts.<id>.h.<zone>`). */
		hostedById: (hostedId: string): Promise<IntakeTarget | null> =>
			db
				.select({ workspace_id: hostedDomains.workspace_id, domain_id: hostedDomains.domain_id, domain: domains.domain })
				.from(hostedDomains)
				.innerJoin(domains, and(eq(domains.id, hostedDomains.domain_id), isNull(domains.evicted_at)))
				.where(/* workspace-scope-exempt: the hosted id identifies the workspace */ eq(hostedDomains.hosted_id, hostedId))
				.get()
				.then((r) => r ?? null),

		/** The hosted domain for a customer hostname, for policy hosts served under the customer's own name. */
		hostedByDomain: (domain: string): Promise<IntakeTarget | null> =>
			db
				.select({ workspace_id: hostedDomains.workspace_id, domain_id: hostedDomains.domain_id, domain: domains.domain })
				.from(hostedDomains)
				.innerJoin(domains, and(eq(domains.id, hostedDomains.domain_id), isNull(domains.evicted_at)))
				.where(/* workspace-scope-exempt: domains.domain is globally unique and identifies the workspace */ eq(domains.domain, domain))
				.get()
				.then((r) => r ?? null),

		/** Every hosted domain, for the daily zone diff (operator-wide, not tenant-facing). */
		allHosted: (): Promise<HostedDomainRow[]> =>
			db.select().from(hostedDomains).where(/* workspace-scope-exempt: operator-wide zone reconciliation */ sql`1 = 1`).all(),
	};
}
