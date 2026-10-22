/**
 * The few lookups that run *before* the account is known: they turn a credential
 * (a user, an API key) into the account(s) it may act in. Every other query takes an
 * account id from the result. Each is a deliberate account-scope exemption (pinned by
 * test/db/account-predicates.test.ts) and returns only what resolving needs.
 */
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { apiKeys, invites, memberships } from '../schema';

export function authLookups(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** Every account a user belongs to, oldest membership first. */
		membershipsOf: (userId: string) =>
			db
				.select({ account_id: memberships.account_id, role: memberships.role })
				.from(memberships)
				.where(/* account-scope-exempt: resolving a user's accounts is the point of this lookup */ eq(memberships.user_id, userId))
				.orderBy(memberships.created_at, memberships.account_id)
				.all(),

		/** An API key by the SHA-256 of its secret. */
		apiKeyByHash: (keyHash: string) =>
			db
				.select()
				.from(apiKeys)
				.where(/* account-scope-exempt: the key hash identifies the account */ eq(apiKeys.key_hash, keyHash))
				.get()
				.then((r) => r ?? null),

		/** An invite by its (unguessable) token, whichever account issued it. */
		inviteByToken: (token: string) =>
			db
				.select()
				.from(invites)
				.where(/* account-scope-exempt: the invite token identifies the account */ eq(invites.token, token))
				.get()
				.then((r) => r ?? null),

		/** The oldest unused, unexpired invite addressed to an email, in any account. */
		pendingInviteForEmail: (email: string, nowSeconds: number) =>
			db
				.select()
				.from(invites)
				.where(/* account-scope-exempt: deciding which account an OAuth sign-up may join */ and(eq(invites.email, email), isNull(invites.used_at), gt(invites.expires_at, nowSeconds)))
				.orderBy(asc(invites.created_at))
				.limit(1)
				.get()
				.then((r) => r ?? null),

		/** Record use, at most once per `minGapSeconds` so authenticated reads do not each cost a write. */
		touchApiKey: (id: string, nowSeconds: number, minGapSeconds = 60) =>
			db
				.update(apiKeys)
				.set(/* account-scope-exempt: addressed by the primary key of a key that was just resolved */ { last_used_at: nowSeconds })
				.where(and(eq(apiKeys.id, id), sql`(${apiKeys.last_used_at} IS NULL OR ${apiKeys.last_used_at} < ${nowSeconds - minGapSeconds})`))
				.run(),
	};
}
