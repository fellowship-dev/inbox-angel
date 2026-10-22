import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { domains, mtaStsConfig, spfFlattenConfig } from '../schema';

export type MtaStsMode = 'testing' | 'enforce';

export function spfFlattenQueries(db: Db, accountId: string) {
	const mine = eq(spfFlattenConfig.account_id, accountId);
	const forDomain = (id: number) => and(mine, eq(spfFlattenConfig.domain_id, id));
	const touch = sql`unixepoch()` as any;

	return {
		get(domainId: number) {
			return db.select().from(spfFlattenConfig).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		allEnabled() {
			return db.select().from(spfFlattenConfig).where(and(mine, eq(spfFlattenConfig.enabled, 1))).all();
		},

		upsert(c: { domain_id: number; canonical_record: string; lookup_count: number | null; cf_record_id: string | null }) {
			return db
				.insert(spfFlattenConfig)
				.values({ account_id: accountId, domain_id: c.domain_id, enabled: 1, cf_record_id: c.cf_record_id, canonical_record: c.canonical_record, lookup_count: c.lookup_count })
				.onConflictDoUpdate({
					target: spfFlattenConfig.domain_id,
					// An upsert must never move a row to another account.
					setWhere: mine,
					set: {
						enabled: 1,
						cf_record_id: sql`COALESCE(excluded.cf_record_id, ${spfFlattenConfig.cf_record_id})`,
						canonical_record: sql`excluded.canonical_record`,
						lookup_count: sql`excluded.lookup_count`,
						last_error: null,
						updated_at: touch,
					},
				})
				.run();
		},

		updateResult(domainId: number, flattened_record: string, ip_count: number, cf_record_id: string) {
			return db
				.update(spfFlattenConfig)
				.set({ flattened_record, ip_count, cf_record_id, last_flattened_at: touch, last_error: null, updated_at: touch })
				.where(forDomain(domainId))
				.run();
		},

		updateError(domainId: number, error: string) {
			return db.update(spfFlattenConfig).set({ last_error: error, updated_at: touch }).where(forDomain(domainId)).run();
		},

		delete(domainId: number) {
			return db.delete(spfFlattenConfig).where(forDomain(domainId)).run();
		},
	};
}

export function mtaStsQueries(db: Db, accountId: string) {
	const mine = eq(mtaStsConfig.account_id, accountId);
	const forDomain = (id: number) => and(mine, eq(mtaStsConfig.domain_id, id));
	const touch = sql`unixepoch()` as any;

	return {
		get(domainId: number) {
			return db.select().from(mtaStsConfig).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		/** Enabled config for a hostname — used to serve /.well-known/mta-sts.txt. */
		getEnabledByDomain(domain: string) {
			return db
				.select({ m: mtaStsConfig })
				.from(mtaStsConfig)
				.innerJoin(domains, and(eq(domains.id, mtaStsConfig.domain_id), eq(domains.account_id, accountId)))
				.where(and(mine, eq(domains.domain, domain), eq(mtaStsConfig.enabled, 1)))
				.get()
				.then((r) => r?.m ?? null);
		},

		allEnabled() {
			return db.select().from(mtaStsConfig).where(and(mine, eq(mtaStsConfig.enabled, 1))).all();
		},

		insert(c: { domain_id: number; mode: MtaStsMode; mx_hosts: string; policy_id: string; mta_sts_record_id: string | null; tls_rpt_record_id: string | null; cname_record_id: string | null }) {
			return db.insert(mtaStsConfig).values({ ...c, account_id: accountId }).run();
		},

		updateMode(domainId: number, mode: MtaStsMode, policy_id: string) {
			return db.update(mtaStsConfig).set({ mode, policy_id, last_error: null, updated_at: touch }).where(forDomain(domainId)).run();
		},

		updateMxHosts(domainId: number, mx_hosts: string, policy_id: string) {
			return db.update(mtaStsConfig).set({ mx_hosts, policy_id, updated_at: touch }).where(forDomain(domainId)).run();
		},

		updateError(domainId: number, error: string) {
			return db.update(mtaStsConfig).set({ last_error: error, updated_at: touch }).where(forDomain(domainId)).run();
		},

		delete(domainId: number) {
			return db.delete(mtaStsConfig).where(forDomain(domainId)).run();
		},
	};
}
