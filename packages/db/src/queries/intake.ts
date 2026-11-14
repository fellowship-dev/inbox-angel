/**
 * Hosted (SaaS) intake: per-domain report tokens and the records a domain has in the operator's
 * hosted-records zone. `intakeLookups` is the one place that runs before the workspace is known:
 * it turns a token (from an inbound address) or a hosted id (from a policy hostname) into the
 * workspace and domain it belongs to, and returns nothing else.
 */
import { and, count, eq, inArray, isNull, ne, gt, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { batchStatements, getDb, type DbLike } from '../client';
import { aggregateReports, domains, hostedDomains, intakeTokens, intakeUsage } from '../schema';

/** How long the previous token keeps working after a rotation (receivers cache the rua address). */
export const TOKEN_ROTATION_GRACE_SECONDS = 72 * 3600;

/** Scope and day of the instance-wide count of stored COUNTED records (intake_quota): `day` is not a date, so no daily sweep matches it. */
export const STORED_ROW = { scope: '*', day: 'total' } as const;
/** The same for UNCOUNTED records (reports of tier unknown/unauthenticated): their own instance budget. */
export const UNCOUNTED_ROW = { scope: '*u', day: 'total' } as const;

export interface QuotaLimits {
	/** Messages per UTC day to one report address (domain). */
	address: number;
	/** Messages per UTC day to one workspace. */
	workspace: number;
	/** Messages per UTC day to the whole instance. */
	instance: number;
	/** Messages from authenticated reporters we do not know, per UTC day to one address, over every such reporter. */
	unknownTotal: number;
	/** Messages that could not be authenticated, per UTC day to one address, over every claimed sender. */
	unauthTotal: number;
	/** Messages from uncounted senders (unknown or unauthenticated), per UTC day to one workspace / to the whole instance: charged INSTEAD of the counted workspace and instance message caps. */
	uncountedWorkspace: number;
	uncountedInstance: number;
}
export type QuotaScope = 'address' | 'unknown' | 'unauth' | 'workspace' | 'instance' | 'uncounted_workspace' | 'uncounted_instance';
export interface QuotaResult {
	ok: boolean;
	/** The first cap that refused the message (nothing was counted then). */
	refusedBy?: QuotaScope;
	/** COUNTED records stored so far today for this address, held by this workspace, and held by the instance (live rows, not per day). */
	addressRecordsToday: number;
	workspaceRecords: number;
	instanceRecords: number;
	/** The same for UNCOUNTED reports: their own, separate figures. */
	uncountedAddressRecordsToday: number;
	uncountedWorkspaceRecords: number;
	uncountedInstanceRecords: number;
}
/** A stored-records budget: counted reports (and legacy rows) or uncounted ones (tier 'unknown' / 'unauthenticated'). */
export const isUncountedTier = (tier: string | null | undefined) => tier === 'unknown' || tier === 'unauthenticated';
export interface DropRow { reporter: string; label: string; first_at: number; last_at: number; messages: number }
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
		 * Count one message against its daily caps in ONE batch: each is a conditional upsert that counts nothing once its cap is reached. When any
		 * refuses, the ones that counted are given back (a second batch). Also returns the stored-records figures the post-parse checks need.
		 *   registry carrier       the COUNTED caps: address, workspace, instance
		 *   authenticated unknown  the address's unknown-reporter total, then the UNCOUNTED workspace and instance caps
		 *   unauthenticated        the address's unauthenticated total, then the UNCOUNTED workspace and instance caps
		 * Uncounted mail is never charged to the counted message caps, so it cannot use them up.
		 */
		async consumeQuota(domainId: number, day: string, bytes: number, carrierClass: 'registry' | 'authenticated' | 'unauthenticated', lim: QuotaLimits): Promise<QuotaResult> {
			const scopes: Array<[QuotaScope, string, number]> = carrierClass === 'registry'
				? [['address', `a:${domainId}`, lim.address], ['workspace', `w:${workspaceId}`, lim.workspace], ['instance', '*', lim.instance]]
				: [carrierClass === 'authenticated' ? ['unknown', `k:${domainId}`, lim.unknownTotal] : ['unauth', `u:${domainId}`, lim.unauthTotal],
					['uncounted_workspace', `n:${workspaceId}`, lim.uncountedWorkspace], ['uncounted_instance', 'n:*', lim.uncountedInstance]];
			const up = (scope: string, max: number) => sql`INSERT INTO intake_quota (scope, day, messages, bytes) VALUES (${scope}, ${day}, 1, ${bytes})
				ON CONFLICT(scope, day) DO UPDATE SET messages = intake_quota.messages + 1, bytes = intake_quota.bytes + excluded.bytes WHERE intake_quota.messages < ${max}`;
			const res = await batchStatements(db, [
				...scopes.map(([, scope, max]) => up(scope, max)),
				sql`SELECT records FROM intake_quota WHERE scope = ${'a:' + domainId} AND day = ${day}`,
				sql`SELECT records, uncounted_records FROM workspace_storage WHERE workspace_id = ${workspaceId}`,
				sql`SELECT records FROM intake_quota WHERE scope = ${STORED_ROW.scope} AND day = ${STORED_ROW.day}`,
				sql`SELECT records FROM intake_quota WHERE scope = ${'ua:' + domainId} AND day = ${day}`,
				sql`SELECT records FROM intake_quota WHERE scope = ${UNCOUNTED_ROW.scope} AND day = ${UNCOUNTED_ROW.day}`,
			]);
			const n = scopes.length;
			const counted = scopes.map((_, i) => (res[i]?.meta?.changes ?? 0) > 0);
			const rows = (i: number) => ((res[n + i]?.results ?? []) as Array<Record<string, number>>)[0];
			const figures = {
				addressRecordsToday: Number(rows(0)?.records ?? 0), workspaceRecords: Number(rows(1)?.records ?? 0), instanceRecords: Number(rows(2)?.records ?? 0),
				uncountedAddressRecordsToday: Number(rows(3)?.records ?? 0), uncountedWorkspaceRecords: Number(rows(1)?.uncounted_records ?? 0), uncountedInstanceRecords: Number(rows(4)?.records ?? 0),
			};
			const refused = counted.findIndex((c) => !c);
			if (refused < 0) return { ok: true, ...figures };
			await this.releaseQuota(domainId, day, bytes, scopes.filter((_, i) => counted[i]).map(([, scope]) => scope));
			return { ok: false, refusedBy: scopes[refused][0], ...figures };
		},

		/** Give back what consumeQuota counted for a message that was then refused by a later check. `scopes` default: every scope it may have used. */
		async releaseQuota(domainId: number, day: string, bytes: number, scopes: string[] = [`a:${domainId}`, `k:${domainId}`, `u:${domainId}`, `w:${workspaceId}`, '*', `n:${workspaceId}`, 'n:*']): Promise<void> {
			if (!scopes.length) return;
			await batchStatements(db, scopes.map((scope) => sql`UPDATE intake_quota SET messages = MAX(0, messages - 1), bytes = MAX(0, bytes - ${bytes}) WHERE scope = ${scope} AND day = ${day}`));
		},

		/**
		 * A COUNTED report was accepted and not stored because the counted budget is full. One row per (domain, reporter) keeps the FIRST drop time
		 * ("reports from Google since <time> were not stored"); it is cleared when a report from that reporter is stored again (the store batch).
		 */
		async markDrop(domainId: number, reporter: string, label: string, nowSeconds: number): Promise<void> {
			await db.run(sql`INSERT INTO intake_drops (domain_id, reporter, workspace_id, label, first_at, last_at, messages) VALUES (${domainId}, ${reporter}, ${workspaceId}, ${label}, ${nowSeconds}, ${nowSeconds}, 1)
				ON CONFLICT(domain_id, reporter) DO UPDATE SET messages = intake_drops.messages + 1, last_at = excluded.last_at, label = excluded.label WHERE intake_drops.workspace_id = ${workspaceId}`);
		},

		/** Reporters whose counted reports were dropped for want of storage on this address, last drop at or after `sinceSeconds`. */
		drops(domainId: number, sinceSeconds: number): Promise<DropRow[]> {
			return db.all<DropRow>(sql`SELECT reporter, label, first_at, last_at, messages FROM intake_drops WHERE workspace_id = ${workspaceId} AND domain_id = ${domainId} AND last_at >= ${sinceSeconds} ORDER BY first_at, reporter`);
		},

		/**
		 * Count one failed attempt to store ONE message (key: a hash of domain + reporter identity + report id) on `day`: the counter that lets an
		 * uncounted sender's report that fails forever be refused for good, without one outage turning every later report of the domain into a
		 * refusal. A row in intake_quota (scope `sf:<key>`, a hash, no content), swept with the other daily counters. Returns this message's failures today.
		 */
		async noteStorageFailure(key: string, day: string): Promise<number> {
			const rows = await db.all<{ messages: number }>(sql`INSERT INTO intake_quota (scope, day, messages) VALUES (${'sf:' + key}, ${day}, 1)
				ON CONFLICT(scope, day) DO UPDATE SET messages = intake_quota.messages + 1 RETURNING messages`);
			return rows[0]?.messages ?? 1;
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

		/** Connect a live domain's reports: its address becomes the hosted fixed address, and the connection starts now. */
		connect(domainId: number, address: string, nowSeconds: number) {
			return db.update(domains).set({ rua_address: address, reports_connected_at: nowSeconds, updated_at: sql`unixepoch()` })
				.where(and(eq(domains.workspace_id, workspaceId), eq(domains.id, domainId), isNull(domains.evicted_at))).run();
		},

		/** Disconnect in one batch: the address is cleared and any token of the domain (current and previous hash) stops working. */
		disconnect(domainId: number) {
			return db.batch([
				db.delete(intakeTokens).where(forDomain(domainId)),
				db.update(domains).set({ rua_address: '', reports_connected_at: null, updated_at: sql`unixepoch()` }).where(and(eq(domains.workspace_id, workspaceId), eq(domains.id, domainId))),
			]);
		},

		/**
		 * Reports stored for the domain since `sinceSeconds`: all of them, the COUNTED ones (reporter_tier 'counted': an authenticated
		 * registry reporter) and the newest counted one; and how many were stored before it. With no `sinceSeconds` (never connected
		 * through this column) every report counts as before.
		 */
		async reportsAround(domainId: number, sinceSeconds: number | null): Promise<{ since: number; counted_since: number; last_counted_since: number | null; before: number }> {
			const since = sinceSeconds ?? Number.MAX_SAFE_INTEGER;
			const isCounted = sql`COALESCE(${aggregateReports.reporter_tier}, '') = 'counted'`;
			const r = await db
				.select({
					since: sql<number>`COALESCE(SUM(CASE WHEN ${aggregateReports.created_at} >= ${since} THEN 1 ELSE 0 END), 0)`,
					counted_since: sql<number>`COALESCE(SUM(CASE WHEN ${aggregateReports.created_at} >= ${since} AND ${isCounted} THEN 1 ELSE 0 END), 0)`,
					last_counted_since: sql<number | null>`MAX(CASE WHEN ${aggregateReports.created_at} >= ${since} AND ${isCounted} THEN ${aggregateReports.created_at} END)`,
					before: sql<number>`COALESCE(SUM(CASE WHEN ${aggregateReports.created_at} < ${since} THEN 1 ELSE 0 END), 0)`,
				})
				.from(aggregateReports)
				.where(and(eq(aggregateReports.workspace_id, workspaceId), eq(aggregateReports.domain_id, domainId)))
				.get();
			return { since: Number(r?.since ?? 0), counted_since: Number(r?.counted_since ?? 0), last_counted_since: r?.last_counted_since ?? null, before: Number(r?.before ?? 0) };
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
		/**
		 * The fixed hosted address's UNATTRIBUTED budget, charged only to mail whose report names a domain nobody connected (after the peek
		 * and a failed attribution), in intake_quota, per UTC day: first the carrier class's total (`total.scope`), and only while that has room,
		 * the sending organisation's own allowance (`bucket.scope`). Once the class total is used up no further per-sender row is created, so
		 * the table grows by at most `total.max` sender rows per class and day. Returns which allowance is exhausted, or null.
		 */
		async consumeUnattributed(day: string, bucket: { scope: string; max: number }, total: { scope: string; max: number }): Promise<'sender' | 'total' | null> {
			const up = (scope: string, max: number) => sql`INSERT INTO intake_quota (scope, day, messages, bytes) VALUES (${scope}, ${day}, 1, 0)
				ON CONFLICT(scope, day) DO UPDATE SET messages = intake_quota.messages + 1 WHERE intake_quota.messages < ${max}`;
			const t = await batchStatements(db, [up(total.scope, total.max)]);
			if ((t[0]?.meta?.changes ?? 0) === 0) return 'total';
			const b = await batchStatements(db, [up(bucket.scope, bucket.max)]);
			if ((b[0]?.meta?.changes ?? 0) > 0) return null;
			await batchStatements(db, [sql`UPDATE intake_quota SET messages = MAX(0, messages - 1) WHERE scope = ${total.scope} AND day = ${day}`]);
			return 'sender';
		},

		/** Count one event against a small instance-wide counter (`scope`, `day`) that refuses past `max`; true when it had room. */
		async consumeCounter(scope: string, day: string, max: number): Promise<boolean> {
			const res = await batchStatements(db, [sql`INSERT INTO intake_quota (scope, day, messages, bytes) VALUES (${scope}, ${day}, 1, 0)
				ON CONFLICT(scope, day) DO UPDATE SET messages = intake_quota.messages + 1 WHERE intake_quota.messages < ${max}`]);
			return (res[0]?.meta?.changes ?? 0) > 0;
		},

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

		/**
		 * The fixed hosted address (`rua@<intake domain>`) carries no token, so the report's own domain picks the target.
		 * `candidates` are the report's domain and its parents up to the organizational domain (built by the caller). The
		 * most specific live, PROVEN domain among them decides: its workspace owns these reports. Proven means verified by
		 * TXT, Cloudflare or self-host, or by 'parent' only while a proven parent of the same workspace is still live (a
		 * subdomain admitted through a parent that has since gone proves nothing). It is the target when it connected
		 * reports (`rua_address` is `address`); otherwise the nearest proven parent of the SAME workspace that connected them
		 * is. Another workspace's parent never receives them. Names are globally unique.
		 */
		async connectedForReport(candidates: string[], address: string): Promise<IntakeTarget | null> {
			if (candidates.length === 0) return null;
			const rows = await db
				.select({ workspace_id: domains.workspace_id, domain_id: domains.id, domain: domains.domain, rua_address: domains.rua_address, verified_via: domains.verified_via })
				.from(domains)
				.where(
					/* workspace-scope-exempt: domains.domain is globally unique and identifies the workspace */
					and(inArray(domains.domain, candidates), isNull(domains.evicted_at), ne(domains.verified_via, 'legacy')),
				)
				.all();
			rows.sort((a, b) => b.domain.length - a.domain.length);
			// Every parent of a candidate is a candidate, so a 'parent' row's parents are all in `rows` (shortest last).
			const proven = new Set<string>();
			for (const r of [...rows].reverse()) {
				const direct = r.verified_via !== 'parent';
				const viaParent = rows.some((p) => p.workspace_id === r.workspace_id && proven.has(p.domain) && r.domain.endsWith(`.${p.domain}`));
				if (direct || viaParent) proven.add(r.domain);
			}
			const live = rows.filter((r) => proven.has(r.domain));
			const owner = live[0];
			if (!owner) return null;
			const hit = live.find((r) => r.workspace_id === owner.workspace_id && (r.rua_address ?? '').trim().toLowerCase() === address.toLowerCase());
			return hit ? { workspace_id: hit.workspace_id, domain_id: hit.domain_id, domain: hit.domain } : null;
		},

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
