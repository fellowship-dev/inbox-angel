import type { DatabaseSync } from 'node:sqlite';
import { createTestD1, applyMigrations, type TestD1 } from '../src/testing';

export function freshDb(): TestD1 {
	const d = createTestD1();
	applyMigrations(d.sqlite);
	return d;
}

/** Order-independent description of every table/index, for comparing two databases. */
export function schemaSnapshot(db: DatabaseSync, ignore = ['_migrations', 'd1_migrations']) {
	const out: Record<string, unknown> = {};
	const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
		.map((r) => r.name)
		.filter((n) => !ignore.includes(n))
		.sort();
	for (const t of tables) {
		const cols = (db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${t}')`).all() as any[])
			.map((c) => `${c.name}:${c.type}:${c.nn || c.pk ? 1 : 0}:${c.d ?? ''}:${c.pk}`) // a PRIMARY KEY column is NOT NULL either way
			.sort();
		const fks = (db.prepare(`SELECT "from" AS f, "table" AS t, "to" AS o, on_delete AS od FROM pragma_foreign_key_list('${t}')`).all() as any[])
			.map((f) => `${f.f}->${f.t}.${f.o}:${f.od}`)
			.sort();
		const idx = (db.prepare(`SELECT name, "unique" AS u, partial AS p FROM pragma_index_list('${t}')`).all() as any[])
			.map((i) => {
				const cols = (db.prepare(`SELECT name FROM pragma_index_info('${i.name}')`).all() as any[]).map((c) => c.name).join(',');
				// A UNIQUE constraint and a plain unique index are the same thing to SQLite.
				return i.u && !i.p ? `unique:${cols}` : `${i.name}:u${i.u}:p${i.p}:${cols}`;
			})
			.sort();
		out[t] = { cols, fks, idx };
	}
	return out;
}
