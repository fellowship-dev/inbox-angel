/**
 * Queries on tables that are deliberately NOT account-scoped (see GLOBAL_TABLES
 * in schema.ts): credentials lookups, anonymous free-check results, the shared
 * IP cache. Anything here must not return or modify tenant data.
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { accounts, authRateLimits, checkResults, ipInfo, users, verifications } from '../schema';

type NewCheckResult = Omit<typeof checkResults.$inferInsert, 'id' | 'created_at'>;

export function globalQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		accounts: {
			/** Every tenant, for crons that fan out per account. */
			create: (id: string, name: string) => db.insert(accounts).values({ id, name }).run(),
			ids: () => db.select({ id: accounts.id }).from(accounts).orderBy(accounts.created_at).all().then((rows) => rows.map((r) => r.id)),
		},

		users: {
			byEmail: (email: string) => db.select().from(users).where(eq(users.email, email)).get().then((r) => r ?? null),
			byId: (id: string) => db.select().from(users).where(eq(users.id, id)).get().then((r) => r ?? null),
			touchLogin: (userId: string) => db.update(users).set({ last_login_at: sql`unixepoch()` as any }).where(eq(users.id, userId)).run(),
			/** Keep the legacy users.role column in step with the membership role (admin = owner or admin). */
			setLegacyRole: (userId: string, role: 'admin' | 'member') => db.update(users).set({ role }).where(eq(users.id, userId)).run(),
			delete: (userId: string) => db.delete(users).where(eq(users.id, userId)).run(),
		},

		/** Who a password-reset token (as emailed) belongs to, if it is still valid. */
		verifications: {
			resetTokenUser: (token: string, nowSeconds: number) =>
				db
					.select({ userId: verifications.value })
					.from(verifications)
					.where(and(eq(verifications.identifier, `reset-password:${token}`), gt(verifications.expiresAt, new Date(nowSeconds * 1000))))
					.get()
					.then((r) => r?.userId ?? null),
		},

		/**
		 * Count one request against a fixed window and say how many the window holds now.
		 * One statement, so concurrent requests cannot all pass a stale read.
		 * `last_request` is the start of the current window, in ms.
		 */
		rateLimit: {
			hit: (key: string, nowMs: number, windowMs: number) => {
				const expired = sql`${nowMs} - ${authRateLimits.lastRequest} >= ${windowMs}`;
				return db
					.insert(authRateLimits)
					.values({ id: crypto.randomUUID(), key, count: 1, lastRequest: nowMs })
					.onConflictDoUpdate({
						target: authRateLimits.key,
						set: {
							count: sql`CASE WHEN ${expired} THEN 1 ELSE ${authRateLimits.count} + 1 END`,
							lastRequest: sql`CASE WHEN ${expired} THEN ${nowMs} ELSE ${authRateLimits.lastRequest} END`,
						},
					})
					.returning({ count: authRateLimits.count, lastRequest: authRateLimits.lastRequest })
					.get();
			},
		},

		checkResults: {
			insert: (r: Omit<NewCheckResult, 'session_token' | 'spf_lookup_count'> & { session_token?: string | null; spf_lookup_count?: number | null }) =>
				db.insert(checkResults).values({ ...r, session_token: r.session_token ?? null, spf_lookup_count: r.spf_lookup_count ?? null }).run(),
			byToken: (token: string) => db.select().from(checkResults).where(eq(checkResults.session_token, token)).get().then((r) => r ?? null),
			/** Latest results for the given sender domains. Callers pass only their own account's domains. */
			latestForDomains: (domains: string[], limit = 20) =>
				domains.length === 0
					? Promise.resolve([])
					: db.select().from(checkResults).where(inArray(checkResults.from_domain, domains)).orderBy(sql`${checkResults.created_at} DESC`).limit(limit).all(),
		},

		ipInfo: {
			get: (ip: string) => db.select().from(ipInfo).where(eq(ipInfo.ip, ip)).get().then((r) => r ?? null),
			upsert: (i: { ip: string; reverse_dns: string | null; base_domain: string | null; country_code: string | null; org: string | null; asn: string | null }) =>
				db
					.insert(ipInfo)
					.values({ ...i, fetched_at: sql`unixepoch()` as any })
					.onConflictDoUpdate({
						target: ipInfo.ip,
						set: {
							reverse_dns: sql`excluded.reverse_dns`,
							base_domain: sql`excluded.base_domain`,
							country_code: sql`excluded.country_code`,
							org: sql`excluded.org`,
							asn: sql`excluded.asn`,
							fetched_at: sql`unixepoch()`,
						},
					})
					.run(),
		},
	};
}
