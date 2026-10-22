import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { betterAuthSchema } from '../src/auth-schema';
import { freshDb } from './helpers';

/**
 * Better Auth's adapter reads these tables under its own field names. Each one must
 * address real columns of the migrated database (`authUser` is a second view of `users`).
 */
describe('Better Auth schema view matches the migrated database', () => {
	const db = freshDb().sqlite;
	for (const [model, table] of Object.entries(betterAuthSchema)) {
		it(`${model} → ${getTableConfig(table).name}`, () => {
			const cfg = getTableConfig(table);
			const actual = new Map((db.prepare(`SELECT name, type, "notnull" AS nn FROM pragma_table_info('${cfg.name}')`).all() as any[]).map((c) => [c.name, c]));
			expect(actual.size).toBeGreaterThan(0);
			for (const col of cfg.columns) {
				const real = actual.get(col.name);
				expect(real, `${cfg.name}.${col.name} exists`).toBeTruthy();
				expect(real!.type.toUpperCase(), `${cfg.name}.${col.name} type`).toBe(col.getSQLType().toUpperCase());
			}
		});
	}
});
