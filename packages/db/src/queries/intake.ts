/**
 * Hosted (SaaS) intake: per-domain report tokens and the records a domain has in the operator's
 * hosted-records zone. `intakeLookups` is the one place that runs before the account is known:
 * it turns a token (from an inbound address) or a hosted id (from a policy hostname) into the
 * account and domain it belongs to, and returns nothing else.
 */
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { getDb, type DbLike } from '../client';
import { domains, hostedDomains, intakeTokens } from '../schema';

/** How long the previous token keeps working after a rotation (receivers cache the rua address). */
export const TOKEN_ROTATION_GRACE_SECONDS = 72 * 3600;

export function intakeQueries(db: Db, accountId: string) {
	const mine = eq(intakeTokens.account_id, accountId);
	const forDomain = (id: number) => and(mine, eq(intakeTokens.domain_id, id));

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
				.values({ domain_id: domainId, account_id: accountId, token_hash: tokenHash })
				.onConflictDoUpdate({
					target: intakeTokens.domain_id,
					// An upsert must never move a row to another account.
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

		delete(domainId: number) {
			return db.delete(intakeTokens).where(forDomain(domainId)).run();
		},
	};
}

export type HostedDomainRow = typeof hostedDomains.$inferSelect;
export type PointerStatus = 'ok' | 'missing' | 'wrong' | 'error';

export function hostedQueries(db: Db, accountId: string) {
	const mine = eq(hostedDomains.account_id, accountId);
	const forDomain = (id: number) => and(mine, eq(hostedDomains.domain_id, id));

	return {
		get(domainId: number) {
			return db.select().from(hostedDomains).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		list() {
			return db.select().from(hostedDomains).where(mine).all();
		},

		insert(h: { domain_id: number; hosted_id: string; zone_key: string }) {
			return db.insert(hostedDomains).values({ ...h, account_id: accountId }).run();
		},

		setRecords(domainId: number, ids: { dmarc_record_id?: string | null; spf_record_id?: string | null; mta_sts_txt_record_id?: string | null; mta_sts_host_record_id?: string | null }) {
			return db.update(hostedDomains).set(ids).where(forDomain(domainId)).run();
		},

		setPointers(domainId: number, p: { dmarc_pointer: PointerStatus; spf_pointer: PointerStatus; mta_sts_pointer: PointerStatus }, nowSeconds: number) {
			return db.update(hostedDomains).set({ ...p, pointers_checked_at: nowSeconds }).where(forDomain(domainId)).run();
		},

		delete(domainId: number) {
			return db.delete(hostedDomains).where(forDomain(domainId)).run();
		},
	};
}

export interface IntakeTarget { account_id: string; domain_id: number; domain: string }

export function intakeLookups(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** The domain a token (as hashed from an inbound address) belongs to: the current token, or the previous one within its grace. */
		resolveToken: (tokenHash: string, nowSeconds: number): Promise<IntakeTarget | null> =>
			db
				.select({ account_id: intakeTokens.account_id, domain_id: intakeTokens.domain_id, domain: domains.domain })
				.from(intakeTokens)
				.innerJoin(domains, eq(domains.id, intakeTokens.domain_id))
				.where(
					/* account-scope-exempt: the token hash identifies the account */
					or(eq(intakeTokens.token_hash, tokenHash), and(eq(intakeTokens.prev_token_hash, tokenHash), gt(intakeTokens.prev_expires_at, nowSeconds))),
				)
				.get()
				.then((r) => r ?? null),

		/** The domain behind an opaque hosted id (the label in `mta-sts.<id>.h.<zone>`). */
		hostedById: (hostedId: string): Promise<IntakeTarget | null> =>
			db
				.select({ account_id: hostedDomains.account_id, domain_id: hostedDomains.domain_id, domain: domains.domain })
				.from(hostedDomains)
				.innerJoin(domains, eq(domains.id, hostedDomains.domain_id))
				.where(/* account-scope-exempt: the hosted id identifies the account */ eq(hostedDomains.hosted_id, hostedId))
				.get()
				.then((r) => r ?? null),

		/** The hosted domain for a customer hostname, for policy hosts served under the customer's own name. */
		hostedByDomain: (domain: string): Promise<IntakeTarget | null> =>
			db
				.select({ account_id: hostedDomains.account_id, domain_id: hostedDomains.domain_id, domain: domains.domain })
				.from(hostedDomains)
				.innerJoin(domains, eq(domains.id, hostedDomains.domain_id))
				.where(/* account-scope-exempt: domains.domain is globally unique and identifies the account */ eq(domains.domain, domain))
				.get()
				.then((r) => r ?? null),

		/** Every hosted domain, for the daily zone diff (operator-wide, not tenant-facing). */
		allHosted: (): Promise<HostedDomainRow[]> =>
			db.select().from(hostedDomains).where(/* account-scope-exempt: operator-wide zone reconciliation */ sql`1 = 1`).all(),
	};
}
