import { describe, it, expect } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import * as schema from '../src/schema';
import { WORKSPACE_OWNED_TABLES, GLOBAL_TABLES } from '../src/schema';
import { freshDb } from './helpers';

const tables = Object.values(schema).filter((v) => is(v as any, SQLiteTable)) as unknown as SQLiteTable[];

const dialect = new SQLiteSyncDialect();
const norm = (x: string) => x.replace(/["`]/g, '').replace(/\b\w+\./g, '').replace(/\s+/g, '').toLowerCase().replace(/^\((.*)\)$/, '$1');
const renderSql = (q: SQL) => {
	const { sql, params } = dialect.sqlToQuery(q);
	let i = 0;
	return sql.replace(/\?/g, () => JSON.stringify(params[i++]).replace(/^"(.*)"$/, "'$1'"));
};
const renderDefault = (d: unknown) => (d !== null && typeof d === 'object' ? renderSql(d as SQL) : typeof d === 'string' ? `'${d}'` : String(d));

const db = freshDb().sqlite;
const dbTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_migrations','d1_migrations')").all() as any[]).map((r) => r.name).sort();

describe('schema.ts matches what migrations/*.sql produce', () => {
	it('declares exactly the migrated tables', () => {
		expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual(dbTables);
	});

	for (const t of tables) {
		const cfg = getTableConfig(t);
		describe(cfg.name, () => {
			const info = db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${cfg.name}')`).all() as any[];

			it('columns: names, types, nullability, defaults, primary key', () => {
				const declared = cfg.columns.map((c) => {
					const pkCols = cfg.primaryKeys.flatMap((p) => p.columns.map((x) => x.name));
					return {
						name: c.name,
						type: c.getSQLType().toUpperCase(),
						// SQLite reports notnull=0 for INTEGER PRIMARY KEY / single-column PKs without NOT NULL
						notNull: c.notNull || c.primary || pkCols.includes(c.name),
						default: c.hasDefault && !c.primary ? norm(renderDefault(c.default)) : null,
					};
				});
				const actual = info.map((c) => ({
					name: c.name,
					type: c.type.toUpperCase(),
					notNull: !!c.nn || !!c.pk,
					default: c.d !== null ? norm(String(c.d)) : null,
				}));
				const by = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
				expect(declared.sort(by)).toEqual(actual.sort(by));
			});

			it('indexes and uniques', () => {
				const declared = [
					...cfg.indexes.map((i) => i.config.name),
				].sort();
				const actual = (db.prepare(`SELECT name FROM pragma_index_list('${cfg.name}') WHERE name NOT LIKE 'sqlite_autoindex%'`).all() as any[]).map((r) => r.name).sort();
				expect(declared).toEqual(actual);
				const uniqueDecl = [
					...cfg.uniqueConstraints.map((u) => u.columns.map((c) => c.name).join(',')),
					...cfg.columns.filter((c) => c.isUnique).map((c) => c.name),
				].sort();
				const uniqueActual = (db.prepare(`SELECT name FROM pragma_index_list('${cfg.name}') WHERE origin = 'u'`).all() as any[])
					.map((r) => (db.prepare(`SELECT name FROM pragma_index_info('${r.name}') ORDER BY seqno`).all() as any[]).map((c) => c.name).join(','))
					.sort();
				expect(uniqueDecl).toEqual(uniqueActual);
			});

			it('index uniqueness and partial-index WHERE clauses', () => {
				for (const i of cfg.indexes) {
					const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(i.config.name) as { sql: string };
					expect(/^\s*CREATE\s+UNIQUE/i.test(row.sql), `${i.config.name} uniqueness`).toBe(!!i.config.unique);
					const actualWhere = row.sql.match(/\bWHERE\b([\s\S]*)$/i)?.[1] ?? null;
					const declaredWhere = i.config.where ? renderSql(i.config.where) : null;
					expect(declaredWhere && norm(declaredWhere), `${i.config.name} WHERE`).toEqual(actualWhere && norm(actualWhere));
				}
			});

			it('foreign keys', () => {
				const declared = cfg.foreignKeys.map((fk) => {
					const r = fk.reference();
					return `${r.columns.map((c) => c.name).join(',')}->${getTableConfig(r.foreignTable).name}.${r.foreignColumns.map((c) => c.name).join(',')}:${(fk.onDelete ?? 'no action').toUpperCase()}`;
				}).sort();
				const actual = (db.prepare(`SELECT "from" AS f, "table" AS t, "to" AS o, on_delete AS od FROM pragma_foreign_key_list('${cfg.name}')`).all() as any[])
					.map((f) => `${f.f}->${f.t}.${f.o}:${f.od.toUpperCase()}`).sort();
				expect(declared).toEqual(actual);
			});
		});
	}

	it('every table is either workspace-owned (has workspace_id) or explicitly global', () => {
		const owned = new Set<string>(WORKSPACE_OWNED_TABLES);
		const global = new Set(Object.keys(GLOBAL_TABLES));
		for (const t of tables) {
			const cfg = getTableConfig(t);
			const has = cfg.columns.some((c) => c.name === 'workspace_id');
			if (global.has(cfg.name)) expect(has, `${cfg.name} is global`).toBe(false);
			else expect(owned.has(cfg.name), `${cfg.name} must be in WORKSPACE_OWNED_TABLES or GLOBAL_TABLES`).toBe(true);
			if (owned.has(cfg.name)) expect(has, `${cfg.name} needs workspace_id`).toBe(true);
		}
	});
});
