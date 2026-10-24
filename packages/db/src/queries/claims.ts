/**
 * Domain ownership claims. A claim is a workspace saying "this domain is ours" before proving it; `domains` only ever
 * holds verified domains, so several workspaces can have a pending claim on the same name while at most one can own it.
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDb, type Db, type DbLike } from '../client';
import { domainClaims, domains, intakeTokens } from '../schema';

export type DomainClaimRow = typeof domainClaims.$inferSelect;

export function claimQueries(db: Db, workspaceId: string) {
	const mine = eq(domainClaims.workspace_id, workspaceId);
	return {
		list() {
			return db.select().from(domainClaims).where(mine).orderBy(asc(domainClaims.id)).all();
		},
		count(): Promise<number> {
			return db.select({ n: sql<number>`count(*)` }).from(domainClaims).where(mine).get().then((r) => r?.n ?? 0);
		},
		get(domain: string) {
			return db.select().from(domainClaims).where(and(mine, eq(domainClaims.domain, domain))).get().then((r) => r ?? null);
		},
		getById(id: number) {
			return db.select().from(domainClaims).where(and(mine, eq(domainClaims.id, id))).get().then((r) => r ?? null);
		},
		/** Create the claim, or return the existing one (the token never changes, so published TXT instructions stay valid). */
		async upsert(domain: string, token: string): Promise<DomainClaimRow> {
			await db.insert(domainClaims).values({ workspace_id: workspaceId, domain, token }).onConflictDoNothing().run();
			return (await db.select().from(domainClaims).where(and(mine, eq(domainClaims.domain, domain))).get())!;
		},
		markLost(id: number) {
			return db.update(domainClaims).set({ status: 'lost' }).where(and(mine, eq(domainClaims.id, id))).run();
		},
		recordCheck(id: number, error: string | null) {
			return db.update(domainClaims).set({ last_checked_at: sql`unixepoch()` as any, last_error: error }).where(and(mine, eq(domainClaims.id, id))).run();
		},
		delete(id: number) {
			return db.delete(domainClaims).where(and(mine, eq(domainClaims.id, id))).run();
		},
		deleteByDomain(domain: string) {
			return db.delete(domainClaims).where(and(mine, eq(domainClaims.domain, domain))).run();
		},
	};
}

/** The two claim queries that deliberately span workspaces: "who verified this name first". They return no tenant data beyond that. */
export function claimLookups(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** Is this name already a verified domain of some workspace other than `workspaceId`? Rows from before verification existed (`legacy`) never count: they were never proven. */
		ownedByOther(domain: string, workspaceId: string): Promise<boolean> {
			return db.select({ id: domains.id }).from(domains /* workspace-scope-exempt: uniqueness of a verified domain is global */)
				.where(and(eq(domains.domain, domain), ne(domains.workspace_id, workspaceId), ne(domains.verified_via, 'legacy'))).get().then((r) => !!r);
		},
		/**
		 * The unproven (`legacy`) holder of `domain` in another workspace, if any: what a proven claim evicts.
		 */
		findLegacyHolder(domain: string, winnerWorkspaceId: string): Promise<{ domainId: number; workspaceId: string } | null> {
			return db.select({ id: domains.id, workspace_id: domains.workspace_id }).from(domains /* workspace-scope-exempt: finding the unproven holder of a name someone else just proved */)
				.where(and(eq(domains.domain, domain), ne(domains.workspace_id, winnerWorkspaceId), eq(domains.verified_via, 'legacy'), isNull(domains.evicted_at))).get()
				.then((r) => (r ? { domainId: r.id, workspaceId: r.workspace_id } : null));
		},
		/**
		 * Detach (not delete) an evicted domain: the name is freed, the row is hidden, and its reports stay for export until
		 * the retention job purges it. Its intake token stops working and its alerts stop.
		 */
		async detach(domainId: number, nowSeconds: number): Promise<void> {
			await db.update(domains /* workspace-scope-exempt: same row, by id */)
				.set({ evicted_at: nowSeconds, evicted_name: sql`${domains.domain}`, domain: sql`'evicted-' || ${domains.id} || '.invalid'`, is_default: 0, alerts_enabled: 0, cf_connection_id: null, dns_record_id: null })
				.where(eq(domains.id, domainId)).run();
			await db.delete(intakeTokens /* workspace-scope-exempt: same domain, by id */).where(eq(intakeTokens.domain_id, domainId)).run();
		},
		/** A workspace verified `domain`: every other workspace's pending claim on it is now lost. */
		markLost(domain: string, winnerWorkspaceId: string) {
			return db.update(domainClaims /* workspace-scope-exempt: other workspaces' claims on a name someone else just verified */).set({ status: 'lost' })
				.where(and(eq(domainClaims.domain, domain), ne(domainClaims.workspace_id, winnerWorkspaceId))).run();
		},
	};
}
