import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { domains, monitorSubscriptions } from '../schema';

type Baseline = Pick<typeof monitorSubscriptions.$inferSelect, 'spf_record' | 'dmarc_policy' | 'dmarc_pct' | 'dmarc_record'>;

export function monitorQueries(db: Db, workspaceId: string) {
	const mine = eq(monitorSubscriptions.workspace_id, workspaceId);

	return {
		insert(s: { email: string; domain: string; session_token?: string | null; confirmed_at?: number | null } & Partial<Baseline>) {
			return db
				.insert(monitorSubscriptions)
				.values({
					workspace_id: workspaceId,
					email: s.email,
					domain: s.domain,
					session_token: s.session_token ?? null,
					spf_record: s.spf_record ?? null,
					dmarc_policy: s.dmarc_policy ?? null,
					dmarc_pct: s.dmarc_pct ?? null,
					dmarc_record: s.dmarc_record ?? null,
					confirmed_at: s.confirmed_at ?? null,
				})
				.onConflictDoNothing({ target: [monitorSubscriptions.workspace_id, monitorSubscriptions.email, monitorSubscriptions.domain] })
				.run();
		},

		/** Active subscriptions on domains with alerts on, least-recently-checked first. */
		active(limit = 100) {
			return db
				.select({ ms: monitorSubscriptions })
				.from(monitorSubscriptions)
				.innerJoin(domains, and(eq(domains.domain, monitorSubscriptions.domain), eq(domains.workspace_id, workspaceId)))
				.where(and(mine, eq(monitorSubscriptions.active, 1), isNotNull(monitorSubscriptions.confirmed_at), eq(domains.alerts_enabled, 1)))
				.orderBy(sql`${monitorSubscriptions.last_checked_at} ASC NULLS FIRST`)
				.limit(limit)
				.all()
				.then((rows) => rows.map((r) => r.ms));
		},

		updateBaseline(id: number, b: Baseline) {
			return db
				.update(monitorSubscriptions)
				.set({
					spf_record: b.spf_record ?? null,
					dmarc_policy: b.dmarc_policy ?? null,
					dmarc_pct: b.dmarc_pct ?? null,
					dmarc_record: b.dmarc_record ?? null,
					last_checked_at: sql`unixepoch()` as any,
				})
				.where(and(mine, eq(monitorSubscriptions.id, id)))
				.run();
		},

		byEmailDomain(email: string, domain: string) {
			return db.select().from(monitorSubscriptions).where(and(mine, eq(monitorSubscriptions.email, email), eq(monitorSubscriptions.domain, domain))).get().then((r) => r ?? null);
		},

		/** Double opt-in: the address owner clicked the link. True only if the subscription (for that address) still exists. */
		confirm(id: number, email: string, nowSeconds: number) {
			return db
				.update(monitorSubscriptions)
				.set({ confirmed_at: sql`coalesce(${monitorSubscriptions.confirmed_at}, ${nowSeconds})` as any })
				.where(and(mine, eq(monitorSubscriptions.id, id), eq(monitorSubscriptions.email, email)))
				.run()
				.then((r) => (r.meta.changes ?? 0) > 0);
		},

		/** Subscriptions nobody confirmed within the window are deleted. Returns how many. */
		deleteUnconfirmedBefore(cutoff: number) {
			return db
				.delete(monitorSubscriptions)
				.where(and(mine, isNull(monitorSubscriptions.confirmed_at), lt(monitorSubscriptions.created_at, cutoff)))
				.run()
				.then((r) => r.meta.changes ?? 0);
		},

		byDomain(domain: string) {
			return db.select().from(monitorSubscriptions).where(and(mine, eq(monitorSubscriptions.domain, domain))).orderBy(asc(monitorSubscriptions.created_at)).all();
		},

		setActive(id: number, active: boolean) {
			return db.update(monitorSubscriptions).set({ active: active ? 1 : 0 }).where(and(mine, eq(monitorSubscriptions.id, id))).run();
		},
	};
}
