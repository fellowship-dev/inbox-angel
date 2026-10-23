/**
 * Applies `migrations/*.sql` to a test database the way
 * `wrangler d1 migrations apply` does: unapplied files in name order, each in
 * one transaction, recorded by name in `d1_migrations`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../migrations');

const D1_MIGRATIONS_DDL =
	'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
	'name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

export function migrationFiles(): string[] {
	return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export function appliedMigrations(db: DatabaseSync): string[] {
	const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'd1_migrations'").get();
	if (!has) return [];
	return (db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]).map((r) => r.name);
}

export interface ApplyOptions {
	/** Only apply files up to and including this one (by name). */
	through?: string;
}

/** Returns the names of the files that ran. */
export function applyMigrations(db: DatabaseSync, opts: ApplyOptions = {}): string[] {
	db.exec(D1_MIGRATIONS_DDL);
	const done = new Set(appliedMigrations(db));
	const ran: string[] = [];
	for (const file of migrationFiles()) {
		if (opts.through && file > opts.through) break;
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
