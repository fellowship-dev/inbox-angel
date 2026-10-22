/**
 * Queries on tables that are deliberately NOT account-scoped (see GLOBAL_TABLES
 * in schema.ts): credentials lookups, anonymous free-check results, the shared
 * IP cache. Anything here must not return or modify tenant data.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { accounts, checkResults, ipInfo, passwordResetTokens, users } from '../schema';

type NewCheckResult = Omit<typeof checkResults.$inferInsert, 'id' | 'created_at'>;

export function globalQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		accounts: {
			/** Every tenant, for crons that fan out per account. */
			ids: () => db.select({ id: accounts.id }).from(accounts).orderBy(accounts.created_at).all().then((rows) => rows.map((r) => r.id)),
		},

		users: {
			byEmail: (email: string) => db.select().from(users).where(eq(users.email, email)).get().then((r) => r ?? null),
			bySession: (token: string) => db.select().from(users).where(eq(users.session_token, token)).get().then((r) => r ?? null),
			setSession: (userId: string, token: string | null) =>
				db.update(users).set({ session_token: token, last_login_at: sql`unixepoch()` as any }).where(eq(users.id, userId)).run(),
			setPasswordHash: (userId: string, hash: string) => db.update(users).set({ password_hash: hash }).where(eq(users.id, userId)).run(),
		},

		passwordResets: {
			insert: (token: string, userId: string, expiresAt: number) =>
				db.insert(passwordResetTokens).values({ token, user_id: userId, expires_at: expiresAt }).run(),
			get: (token: string) => db.select().from(passwordResetTokens).where(eq(passwordResetTokens.token, token)).get().then((r) => r ?? null),
			markUsed: (token: string) => db.update(passwordResetTokens).set({ used_at: sql`unixepoch()` as any }).where(eq(passwordResetTokens.token, token)).run(),
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
