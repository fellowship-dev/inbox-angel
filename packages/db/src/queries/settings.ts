import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { settings } from '../schema';

export function settingsQueries(db: Db, accountId: string) {
	const upsert = (key: string, value: string) =>
		db
			.insert(settings)
			.values({ account_id: accountId, key, value })
			.onConflictDoUpdate({
				target: [settings.account_id, settings.key],
				set: { value: sql`excluded.value`, updated_at: sql`unixepoch()` as any },
			});

	return {
		/** `{ value }` or null — same shape the app has always used. */
		get(key: string) {
			return db
				.select({ value: settings.value })
				.from(settings)
				.where(and(eq(settings.account_id, accountId), eq(settings.key, key)))
				.get()
				.then((r) => r ?? null);
		},

		/** Store `value` only if the key is unset, then return whatever is stored (safe under concurrent first calls). */
		async setIfAbsent(key: string, value: string): Promise<string> {
			await db.insert(settings).values({ account_id: accountId, key, value }).onConflictDoNothing().run();
			const row = await db
				.select({ value: settings.value })
				.from(settings)
				.where(and(eq(settings.account_id, accountId), eq(settings.key, key)))
				.get();
			return row!.value;
		},

		set(key: string, value: string) {
			return upsert(key, value).run();
		},

		/** Batch-fetch several settings in one round-trip. Missing keys are omitted. */
		async getMany(keys: string[]): Promise<Map<string, string>> {
			if (keys.length === 0) return new Map();
			const rows = await db
				.select({ key: settings.key, value: settings.value })
				.from(settings)
				.where(and(eq(settings.account_id, accountId), inArray(settings.key, keys)));
			return new Map(rows.map((r) => [r.key, r.value]));
		},

		/** Upsert many config values atomically. */
		async setMany(config: Record<string, string>): Promise<void> {
			const stmts = Object.entries(config).map(([k, v]) => upsert(k, v));
			if (stmts.length === 0) return;
			await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
		},
	};
}
