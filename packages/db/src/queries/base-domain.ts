import { and, eq } from 'drizzle-orm';
import { unwrapDriverError, type Db } from '../client';
import { domains, settings } from '../schema';
import { sql } from 'drizzle-orm';

/**
 * The wizard's first step as one batch: the domain row (when new) and the derived settings (base domain,
 * reports domain, from address, a forgotten zone) are written together or not at all. A hostname or a
 * reports domain another workspace already owns makes the whole batch fail with a UNIQUE error
 * (domains.domain, idx_settings_reports_domain), leaving nothing half-written.
 */
export function baseDomainQueries(db: Db, workspaceId: string) {
	const upsert = (key: string, value: string) =>
		db
			.insert(settings)
			.values({ workspace_id: workspaceId, key, value })
			.onConflictDoUpdate({
				target: [settings.workspace_id, settings.key],
				set: { value: sql`excluded.value`, updated_at: sql`unixepoch()` as any },
			});

	return {
		/** Returns the new domain's id, or null when the workspace already had the domain. */
		async apply(d: { domain: string; rua_address: string; verified_via?: string; settings: Record<string, string> }): Promise<number | null> {
			const existing = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.workspace_id, workspaceId), eq(domains.domain, d.domain))).get();
			const parts = d.domain.split('.');
			let parentId: number | null = null;
			if (!existing && parts.length > 2) {
				const parent = await db
					.select({ id: domains.id })
					.from(domains)
					.where(and(eq(domains.workspace_id, workspaceId), eq(domains.domain, parts.slice(1).join('.'))))
					.get();
				parentId = parent?.id ?? null;
			}
			const stmts = [
				...(existing ? [] : [db.insert(domains).values({ workspace_id: workspaceId, domain: d.domain, rua_address: d.rua_address, parent_id: parentId, verified_via: d.verified_via })]),
				...Object.entries(d.settings).map(([k, v]) => upsert(k, v)),
			];
			try {
				const res = await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
				return existing ? null : ((res[0] as any).meta?.last_row_id as number);
			} catch (e) {
				throw unwrapDriverError(e); // callers match on 'UNIQUE'
			}
		},
	};
}
