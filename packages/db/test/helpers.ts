import type { DatabaseSync } from 'node:sqlite';
import { createTestD1, applyMigrations, type TestD1 } from '../src/testing';
import { LEGACY_RUNTIME_MIGRATIONS } from './fixtures/legacy-runtime';

/** What ensureMigrated() did on first request: statement by statement, ALTER errors swallowed. */
export function runLegacyRuntime(db: DatabaseSync, upTo = 16) {
	db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
	for (const m of LEGACY_RUNTIME_MIGRATIONS) {
		if (m.version > upTo) break;
		for (const stmt of m.sql.split(';').map((s) => s.trim()).filter(Boolean)) {
			try {
				db.exec(stmt);
			} catch (e) {
				if (!stmt.toUpperCase().startsWith('ALTER')) throw e;
			}
		}
		db.prepare('INSERT OR IGNORE INTO _migrations (version, applied_at) VALUES (?, ?)').run(m.version, 'x');
	}
}

export const F = {
	initial: '0001_initial.sql',
	dnsRecord: '0002_add_dns_record_id.sql',
	token: '0003_check_session_token.sql',
	monitor: '0004_monitor_subscriptions.sql',
	rollout: '0005_rollout_stage.sql',
	subdomain: '0005_subdomain_parent.sql',
	isDefault: '0006_add_is_default.sql',
	/** The name 0006 had before the merge that renamed it. */
	isDefaultOldName: '0005_add_is_default.sql',
} as const;

/** Apply exactly these historical files, as wrangler would have, with no adoption. */
export function applyHistorical(db: DatabaseSync, files: string[]) {
	applyMigrations(db, { only: files, adopt: false });
}

export function renameApplied(db: DatabaseSync, from: string, to: string) {
	db.prepare('UPDATE d1_migrations SET name = ? WHERE name = ?').run(to, from);
}

export function tableExists(db: DatabaseSync, name: string) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

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
			.map((c) => `${c.name}:${c.type}:${c.nn}:${c.d ?? ''}:${c.pk}`)
			.sort();
		const fks = (db.prepare(`SELECT "from" AS f, "table" AS t, "to" AS o, on_delete AS od FROM pragma_foreign_key_list('${t}')`).all() as any[])
			.map((f) => `${f.f}->${f.t}.${f.o}:${f.od}`)
			.sort();
		const idx = (db.prepare(`SELECT name, "unique" AS u, partial AS p FROM pragma_index_list('${t}')`).all() as any[])
			.map((i) => {
				const cols = (db.prepare(`SELECT name FROM pragma_index_info('${i.name}')`).all() as any[]).map((c) => c.name).join(',');
				return `${i.name.startsWith('sqlite_autoindex') ? 'auto' : i.name}:u${i.u}:p${i.p}:${cols}`;
			})
			.sort();
		out[t] = { cols, fks, idx };
	}
	return out;
}
