/**
 * Queries on tables that are deliberately NOT workspace-scoped (see GLOBAL_TABLES
 * in schema.ts): credentials lookups, anonymous free-check results, the shared
 * IP cache. Anything here must not return or modify tenant data.
 */
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { workspaces, authAccounts, authRateLimits, sessions, canaryTokens, checkResults, hostedZones, ipInfo, users, verifications } from '../schema';

type NewCheckResult = Omit<typeof checkResults.$inferInsert, 'id' | 'created_at'>;

export function globalQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		workspaces: {
			/** Every tenant, for crons that fan out per workspace. */
			create: (id: string, name: string) => db.insert(workspaces).values({ id, name }).run(),
			ids: () => db.select({ id: workspaces.id }).from(workspaces).orderBy(workspaces.created_at).all().then((rows) => rows.map((r) => r.id)),
		},

		users: {
			byEmail: (email: string) => db.select().from(users).where(eq(users.email, email)).get().then((r) => r ?? null),
			byId: (id: string) => db.select().from(users).where(eq(users.id, id)).get().then((r) => r ?? null),
			touchLogin: (userId: string) => db.update(users).set({ last_login_at: sql`unixepoch()` as any }).where(eq(users.id, userId)).run(),
			/** Keep the legacy users.role column in step with the membership role (admin = owner or admin). */
			setLegacyRole: (userId: string, role: 'admin' | 'member') => db.update(users).set({ role }).where(eq(users.id, userId)).run(),
			delete: (userId: string) => db.delete(users).where(eq(users.id, userId)).run(),
			/** Does this user have a password login (as opposed to OAuth only)? */
			hasPassword: (userId: string) =>
				db.select({ id: authAccounts.id }).from(authAccounts).where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'credential'), sql`${authAccounts.password} IS NOT NULL AND ${authAccounts.password} <> '!'`)).get().then((r) => !!r),
			/** Make the stored password unusable ('!' never matches a hash): used when a password was chosen before the email was proven. */
			discardPassword: (userId: string) =>
				db.update(authAccounts).set({ password: '!' }).where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'credential'))).run(),
			markEmailVerified: (userId: string) => db.update(users).set({ email_verified: 1 }).where(eq(users.id, userId)).run(),
			/** Delete a user who belongs to no workspace any more (their sessions and keys go with them). */
			deleteIfOrphan: (userId: string) =>
				db.run(sql`DELETE FROM users WHERE id = ${userId} AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${userId})`),
		},

		sessions: {
			/** Sign a user out everywhere. */
			revokeAll: (userId: string) => db.delete(sessions).where(eq(sessions.userId, userId)).run(),
		},

		/** Who a password-reset token (as emailed) belongs to, if it is still valid. */
		verifications: {
			/** A one-hour password-reset token, as the reset email would carry (used to turn email verification into a set-password step). */
			createResetToken: (userId: string, token: string, nowSeconds: number) =>
				db.insert(verifications).values({ id: crypto.randomUUID(), identifier: `reset-password:${token}`, value: userId, expiresAt: new Date((nowSeconds + 3600) * 1000) }).run(),
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
			/**
			 * The newest check for each of the given domains, at the domain level only: who ran the check (from_email,
			 * session_token) is never part of it. Callers pass only domains their workspace has verified.
			 */
			async latestPerDomain(domains: string[], limit = 20) {
				if (domains.length === 0) return [];
				const rows = await db
					.select({
						id: checkResults.id,
						from_domain: checkResults.from_domain,
						spf_result: checkResults.spf_result,
						spf_domain: checkResults.spf_domain,
						spf_record: checkResults.spf_record,
						dkim_result: checkResults.dkim_result,
						dkim_domain: checkResults.dkim_domain,
						dmarc_result: checkResults.dmarc_result,
						dmarc_policy: checkResults.dmarc_policy,
						dmarc_record: checkResults.dmarc_record,
						overall_status: checkResults.overall_status,
						spf_lookup_count: checkResults.spf_lookup_count,
						created_at: checkResults.created_at,
					})
					.from(checkResults)
					.where(inArray(checkResults.from_domain, domains))
					.orderBy(sql`${checkResults.created_at} DESC`, sql`${checkResults.id} DESC`)
					.limit(500)
					.all();
				const seen = new Set<string>();
				return rows.filter((r) => (seen.has(r.from_domain) ? false : (seen.add(r.from_domain), true))).slice(0, limit);
			},
		},

		/** Record counts of the operator's hosted-records zone(s). */
		hostedZones: {
			get: (zoneKey: string) => db.select().from(hostedZones).where(eq(hostedZones.zone_key, zoneKey)).get().then((r) => r ?? null),
			list: () => db.select().from(hostedZones).all(),
			/** Register a zone, or refresh its Cloudflare id/name; the count is left alone. */
			upsert: (z: { zone_key: string; zone_id: string; zone_name: string }) =>
				db.insert(hostedZones).values(z).onConflictDoUpdate({ target: hostedZones.zone_key, set: { zone_id: sql`excluded.zone_id`, zone_name: sql`excluded.zone_name` } }).run(),
			/** Our own bookkeeping between daily counts: one statement, so concurrent writers do not lose updates. */
			addCount: (zoneKey: string, delta: number) =>
				db.update(hostedZones).set({ record_count: sql`MAX(0, ${hostedZones.record_count} + ${delta})` }).where(eq(hostedZones.zone_key, zoneKey)).run(),
			/** The daily count from Cloudflare itself (every record in the zone). */
			setObserved: (zoneKey: string, recordCount: number, restDigest: string, nowSeconds: number) =>
				db.update(hostedZones).set({ record_count: recordCount, rest_digest: restDigest, checked_at: nowSeconds }).where(eq(hostedZones.zone_key, zoneKey)).run(),
		},

		/** Addresses for the anonymous free check: expiring, single use, hash only. */
		canary: {
			issue: (tokenHash: string, expiresAt: number) => db.insert(canaryTokens).values({ token_hash: tokenHash, expires_at: expiresAt }).run(),
			/** Use a token once. True when it existed, had not expired and had not been used. */
			consume: (tokenHash: string, nowSeconds: number) =>
				db
					.update(canaryTokens)
					.set({ used_at: nowSeconds })
					.where(and(eq(canaryTokens.token_hash, tokenHash), isNull(canaryTokens.used_at), gt(canaryTokens.expires_at, nowSeconds)))
					.returning({ h: canaryTokens.token_hash })
					.all()
					.then((rows) => rows.length > 0),
			purgeExpired: (nowSeconds: number) => db.delete(canaryTokens).where(lt(canaryTokens.expires_at, nowSeconds - 86400)).run(),
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
