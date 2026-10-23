import { and, asc, eq, sql } from 'drizzle-orm';
import { unwrapDriverError, type Db } from '../client';
import { cloudflareConnections, domains } from '../schema';

export function domainQueries(db: Db, workspaceId: string) {
	const mine = eq(domains.workspace_id, workspaceId);
	const touch = sql`unixepoch()`;

	return {
		getByName(domain: string) {
			return db.select().from(domains).where(and(mine, eq(domains.domain, domain))).get().then((r) => r ?? null);
		},

		getById(id: number) {
			return db.select().from(domains).where(and(mine, eq(domains.id, id))).get().then((r) => r ?? null);
		},

		list() {
			return db.select().from(domains).where(mine).orderBy(asc(domains.id)).all();
		},

		subdomains(parentId: number) {
			return db.select().from(domains).where(and(mine, eq(domains.parent_id, parentId))).orderBy(asc(domains.domain)).all();
		},

		/** The workspace's default ("home base") domain, if one is set. */
		getDefault() {
			return db.select().from(domains).where(and(mine, eq(domains.is_default, 1))).limit(1).get().then((r) => r ?? null);
		},

		async insert(d: { domain: string; rua_address: string }) {
			// Auto-detect parent: strip the leftmost label and check if the apex exists
			const parts = d.domain.split('.');
			let parentId: number | null = null;
			if (parts.length > 2) {
				const parent = await db
					.select({ id: domains.id })
					.from(domains)
					.where(and(mine, eq(domains.domain, parts.slice(1).join('.'))))
					.get();
				if (parent) parentId = parent.id;
			}
			try {
				return await db.insert(domains).values({ workspace_id: workspaceId, domain: d.domain, rua_address: d.rua_address, parent_id: parentId }).run();
			} catch (e) {
				throw unwrapDriverError(e); // callers match on 'UNIQUE'
			}
		},

		delete(id: number) {
			return db.delete(domains).where(and(mine, eq(domains.id, id))).run();
		},

		/** Make `id` the workspace's only default domain (atomic). */
		setDefault(id: number) {
			return db.batch([
				db.update(domains).set({ is_default: 0 }).where(mine),
				db.update(domains).set({ is_default: 1 }).where(and(mine, eq(domains.id, id))),
			]);
		},

		updateSpfLookupCount(id: number, count: number) {
			return db.update(domains).set({ spf_lookup_count: count, updated_at: touch as any }).where(and(mine, eq(domains.id, id))).run();
		},

		updateDmarcPolicy(id: number, policy: string) {
			return db.update(domains).set({ dmarc_policy: policy, updated_at: touch as any }).where(and(mine, eq(domains.id, id))).run();
		},

		updateRollout(id: number, policy: string, pct: number) {
			return db.update(domains).set({ rollout_rec_policy: policy, rollout_rec_pct: pct, updated_at: touch as any }).where(and(mine, eq(domains.id, id))).run();
		},

		/** Link a domain to one of this workspace's Cloudflare connections (null unlinks). False: no such domain or connection. */
		async setConnection(id: number, connectionId: string | null): Promise<boolean> {
			if (connectionId !== null) {
				const c = await db.select({ id: cloudflareConnections.id }).from(cloudflareConnections)
					.where(and(eq(cloudflareConnections.workspace_id, workspaceId), eq(cloudflareConnections.id, connectionId))).get();
				if (!c) return false;
			}
			const r = await db.update(domains).set({ cf_connection_id: connectionId, updated_at: touch as any }).where(and(mine, eq(domains.id, id))).run();
			return (r.meta.changes ?? 0) > 0;
		},

		setAlertsEnabled(id: number, enabled: boolean) {
			return db.update(domains).set({ alerts_enabled: enabled ? 1 : 0 }).where(and(mine, eq(domains.id, id))).run();
		},

		/** Record the Cloudflare DNS record that authorises this domain's reports. */
		setDnsRecord(id: number, recordId: string, opts: { provisioned?: boolean; touch?: boolean } = {}) {
			return db
				.update(domains)
				.set({
					dns_record_id: recordId,
					...(opts.provisioned ? { auth_record_provisioned: 1 } : {}),
					...(opts.touch ? { updated_at: touch as any } : {}),
				})
				.where(and(mine, eq(domains.id, id)))
				.run();
		},
	};
}
