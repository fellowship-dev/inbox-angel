/**
 * Applies `migrations/*.sql` to a test database the way
 * `wrangler d1 migrations apply` does: unapplied files in name order, each in
 * one transaction, recorded by name in `d1_migrations`. Optionally runs the
 * adoption step first, as `npm run migrate` does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { D1_MIGRATIONS_DDL, INTROSPECT_COLUMNS_SQL, groupColumns, planAdoption } from '../adopt';

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../migrations');

export function migrationFiles(): string[] {
	return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export function appliedMigrations(db: DatabaseSync): string[] {
	const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'd1_migrations'").get();
	if (!has) return [];
	return (db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]).map((r) => r.name);
}

/** Record migrations whose effects already exist (see src/adopt.js). */
export function adopt(db: DatabaseSync) {
	const columns = groupColumns(db.prepare(INTROSPECT_COLUMNS_SQL).all() as { tbl: string; col: string }[]);
	const plan = planAdoption(columns, appliedMigrations(db));
	for (const s of plan.statements) db.exec(s);
	return plan;
}

export interface ApplyOptions {
	/** Only apply files up to and including this one (by name). */
	through?: string;
	/** Only apply these files (skips the rest). Takes precedence over `through`. */
	only?: string[];
	/** Run the adoption step first (what `npm run migrate` does). Default true. */
	adopt?: boolean;
}

export function applyMigrations(db: DatabaseSync, opts: ApplyOptions = {}): string[] {
	if (opts.adopt !== false) adopt(db);
	db.exec(D1_MIGRATIONS_DDL);
	const done = new Set(appliedMigrations(db));
	const ran: string[] = [];
	for (const file of migrationFiles()) {
		if (opts.only && !opts.only.includes(file)) continue;
		if (!opts.only && opts.through && file > opts.through) break;
		if (done.has(file)) continue;
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
		db.exec('BEGIN');
		try {
			db.exec(sql);
			db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw new Error(`migration ${file} failed: ${(e as Error).message}`);
		}
		ran.push(file);
	}
	return ran;
}
