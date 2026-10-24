/**
 * Hosted (SaaS) intake: per-domain report tokens and the records a domain has in the operator's
 * hosted-records zone. `intakeLookups` is the one place that runs before the workspace is known:
 * it turns a token (from an inbound address) or a hosted id (from a policy hostname) into the
 * workspace and domain it belongs to, and returns nothing else.
 */
import { and, count, eq, notInArray, gt, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { getDb, type DbLike } from '../client';
import { domains, hostedDomains, intakeTokens, intakeUsage } from '../schema';

/** How long the previous token keeps working after a rotation (receivers cache the rua address). */
export const TOKEN_ROTATION_GRACE_SECONDS = 72 * 3600;

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
		 * Atomically count one report of `bytes` against the allowance of (domain, `day` (YYYY-MM-DD, UTC), `reporter`).
		 * `reporter` is a proven reporter's organisational domain, or `~<claimed sender domain>` for an unproven message ('~' alone: the overflow bucket). Returns false, and counts nothing, when it would exceed
		 * `maxReports` or `maxBytes`, or (a proven reporter that is not `wellKnown`) when it is out of its own cap. Past `maxDistinct`
		 * unknown proven reporters a day the least-used one is dropped to make room; an unproven sender falls into the overflow bucket instead. (best-effort bound: the check and the insert are separate statements).
		 */
		async tryConsume(domainId: number, day: string, reporter: string, bytes: number, maxReports: number, maxBytes: number, maxDistinct = 100, wellKnown: readonly string[] = []): Promise<boolean> {
			if (maxReports < 1 || bytes > maxBytes) return false;
			// '~…' keys are unproven senders (by the sender domain they claim), everything else is a proven reporter domain:
			// the two kinds are counted and bounded separately, and never share an allowance.
			const unproven = reporter.startsWith('~');
			const dayRows = and(mine_usage(), eq(intakeUsage.domain_id, domainId), eq(intakeUsage.day, day));
			const kind = unproven ? sql`${intakeUsage.reporter} LIKE '~%'` : sql`${intakeUsage.reporter} NOT LIKE '~%'`;
			const known = !unproven && wellKnown.includes(reporter);
			const seen = await db.select({ n: count() }).from(intakeUsage).where(and(dayRows, eq(intakeUsage.reporter, reporter))).get();
			if (!seen?.n && !known) {
				// Slots are for reporters we know nothing about; well-known ones neither use nor need one.
				const unknown = and(dayRows, kind, wellKnown.length ? notInArray(intakeUsage.reporter, [...wellKnown]) : undefined);
				const distinct = await db.select({ n: count() }).from(intakeUsage).where(unknown).get();
				if ((distinct?.n ?? 0) >= maxDistinct) {
					if (unproven) reporter = '~'; // more claimed senders than bucket slots: the rest share one overflow bucket
					else {
						// All slots taken: the least-used unknown reporter makes way, so a new one is never refused and junk
						// domains cannot lock genuine ones out for the day.
						const victim = await db.select({ r: intakeUsage.reporter }).from(intakeUsage).where(unknown).orderBy(intakeUsage.reports, intakeUsage.bytes).limit(1).get();
						if (victim) await db.delete(intakeUsage).where(and(dayRows, eq(intakeUsage.reporter, victim.r))).run();
					}
				}
			}
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
				.innerJoin(domains, eq(domains.id, intakeTokens.domain_id))
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
				.innerJoin(domains, eq(domains.id, hostedDomains.domain_id))
				.where(/* workspace-scope-exempt: the hosted id identifies the workspace */ eq(hostedDomains.hosted_id, hostedId))
				.get()
				.then((r) => r ?? null),

		/** The hosted domain for a customer hostname, for policy hosts served under the customer's own name. */
		hostedByDomain: (domain: string): Promise<IntakeTarget | null> =>
			db
				.select({ workspace_id: hostedDomains.workspace_id, domain_id: hostedDomains.domain_id, domain: domains.domain })
				.from(hostedDomains)
				.innerJoin(domains, eq(domains.id, hostedDomains.domain_id))
				.where(/* workspace-scope-exempt: domains.domain is globally unique and identifies the workspace */ eq(domains.domain, domain))
				.get()
				.then((r) => r ?? null),

		/** Every hosted domain, for the daily zone diff (operator-wide, not tenant-facing). */
		allHosted: (): Promise<HostedDomainRow[]> =>
			db.select().from(hostedDomains).where(/* workspace-scope-exempt: operator-wide zone reconciliation */ sql`1 = 1`).all(),
	};
}
