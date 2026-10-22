/**
 * Cloudflare connections of one account, and the zones each may manage.
 *
 * `list`/`get` never select `token_envelope`: the ciphertext leaves the database only through
 * `getSecret`, which the connection layer (src/connections) calls to decrypt a token.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { cloudflareConnectionZones, cloudflareConnections, domains, type CfAuthType, type CfConnectionStatus } from '../schema';

const publicCols = {
	id: cloudflareConnections.id,
	label: cloudflareConnections.label,
	cf_account_id: cloudflareConnections.cf_account_id,
	cf_account_name: cloudflareConnections.cf_account_name,
	auth_type: cloudflareConnections.auth_type,
	scopes: cloudflareConnections.scopes,
	status: cloudflareConnections.status,
	status_detail: cloudflareConnections.status_detail,
	created_by: cloudflareConnections.created_by,
	created_at: cloudflareConnections.created_at,
	last_used_at: cloudflareConnections.last_used_at,
};

export type CfConnectionInfo = {
	id: string;
	label: string;
	cf_account_id: string | null;
	cf_account_name: string | null;
	auth_type: CfAuthType;
	scopes: string | null;
	status: CfConnectionStatus;
	status_detail: string | null;
	created_by: string | null;
	created_at: number;
	last_used_at: number | null;
};

export interface CfConnectionZone { zone_id: string; zone_name: string; cf_account_id?: string | null }

export function connectionQueries(db: Db, accountId: string) {
	const mine = eq(cloudflareConnections.account_id, accountId);
	const one = (id: string) => and(mine, eq(cloudflareConnections.id, id));
	const myZones = eq(cloudflareConnectionZones.account_id, accountId);

	return {
		list(): Promise<CfConnectionInfo[]> {
			return db.select(publicCols).from(cloudflareConnections).where(mine).orderBy(asc(cloudflareConnections.created_at), asc(cloudflareConnections.id)).all();
		},

		get(id: string): Promise<CfConnectionInfo | null> {
			return db.select(publicCols).from(cloudflareConnections).where(one(id)).get().then((r) => r ?? null);
		},

		/** The stored envelope with just enough to use it. Only the connection layer calls this. */
		getSecret(id: string) {
			return db
				.select({
					id: cloudflareConnections.id,
					auth_type: cloudflareConnections.auth_type,
					status: cloudflareConnections.status,
					token_envelope: cloudflareConnections.token_envelope,
					cf_account_id: cloudflareConnections.cf_account_id,
					label: cloudflareConnections.label,
					last_used_at: cloudflareConnections.last_used_at,
				})
				.from(cloudflareConnections)
				.where(one(id))
				.get()
				.then((r) => r ?? null);
		},

		insert(c: {
			id: string;
			label: string;
			cf_account_id?: string | null;
			cf_account_name?: string | null;
			auth_type: CfAuthType;
			token_envelope: string;
			scopes?: string | null;
			created_by?: string | null;
		}) {
			return db
				.insert(cloudflareConnections)
				.values({ ...c, cf_account_id: c.cf_account_id ?? null, cf_account_name: c.cf_account_name ?? null, scopes: c.scopes ?? null, created_by: c.created_by ?? null, account_id: accountId })
				.run();
		},

		/**
		 * Replace the envelope (a refresh, or a re-encryption under a newer key). Compare-and-swap on the old
		 * envelope: when two isolates refresh at once (refresh tokens are single-use) only one write wins.
		 * Returns whether this call wrote.
		 */
		async swapEnvelope(id: string, expected: string, next: string): Promise<boolean> {
			const r = await db
				.update(cloudflareConnections)
				.set({ token_envelope: next })
				.where(and(one(id), eq(cloudflareConnections.token_envelope, expected)))
				.run();
			return (r.meta.changes ?? 0) > 0;
		},

		/** Reconnect: store a new envelope and make the connection active again. */
		async reactivate(id: string, envelope: string, scopes: string | null): Promise<boolean> {
			const r = await db
				.update(cloudflareConnections)
				.set({ token_envelope: envelope, scopes, status: 'active', status_detail: null })
				.where(one(id))
				.run();
			return (r.meta.changes ?? 0) > 0;
		},

		setStatus(id: string, status: CfConnectionStatus, detail: string | null = null) {
			return db.update(cloudflareConnections).set({ status, status_detail: detail }).where(one(id)).run();
		},

		/** active → broken. Returns whether this call made the change (so the alert goes out once). */
		async markBroken(id: string, detail: string): Promise<boolean> {
			const r = await db
				.update(cloudflareConnections)
				.set({ status: 'broken', status_detail: detail })
				.where(and(one(id), eq(cloudflareConnections.status, 'active')))
				.run();
			return (r.meta.changes ?? 0) > 0;
		},

		markUsed(id: string, nowSeconds: number) {
			return db.update(cloudflareConnections).set({ last_used_at: nowSeconds }).where(one(id)).run();
		},

		async delete(id: string): Promise<boolean> {
			// Explicit even though the foreign key does the same: linked domains must never keep a dangling id.
			await db.update(domains).set({ cf_connection_id: null }).where(and(eq(domains.account_id, accountId), eq(domains.cf_connection_id, id))).run();
			const r = await db.delete(cloudflareConnections).where(one(id)).run();
			return (r.meta.changes ?? 0) > 0;
		},

		// ── Allow-list ──────────────────────────────────────────

		zones(connectionId: string): Promise<CfConnectionZone[]> {
			return db
				.select({ zone_id: cloudflareConnectionZones.zone_id, zone_name: cloudflareConnectionZones.zone_name, cf_account_id: cloudflareConnectionZones.cf_account_id })
				.from(cloudflareConnectionZones)
				.where(and(myZones, eq(cloudflareConnectionZones.connection_id, connectionId)))
				.orderBy(asc(cloudflareConnectionZones.zone_name))
				.all();
		},

		/** Replace the allow-list (atomic). False when the connection is not this account's. */
		async setZones(connectionId: string, zones: CfConnectionZone[]): Promise<boolean> {
			const owned = await db.select({ id: cloudflareConnections.id }).from(cloudflareConnections).where(one(connectionId)).get();
			if (!owned) return false;
			const clear = db.delete(cloudflareConnectionZones).where(and(myZones, eq(cloudflareConnectionZones.connection_id, connectionId)));
			if (zones.length === 0) await clear.run();
			else {
				await db.batch([
					clear,
					db.insert(cloudflareConnectionZones).values(zones.map((z) => ({ connection_id: connectionId, account_id: accountId, zone_id: z.zone_id, zone_name: z.zone_name.toLowerCase(), cf_account_id: z.cf_account_id ?? null }))),
				]);
			}
			return true;
		},

		/** Domains linked to a connection (for the delete warning). */
		async linkedDomainCount(connectionId: string): Promise<number> {
			const r = await db
				.select({ n: sql<number>`count(*)` })
				.from(domains)
				.where(and(eq(domains.account_id, accountId), eq(domains.cf_connection_id, connectionId)))
				.get();
			return r?.n ?? 0;
		},
	};
}
