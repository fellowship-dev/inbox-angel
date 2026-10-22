/**
 * Adopting an existing install into the wrangler migration history.
 *
 * `wrangler d1 migrations apply` decides what to run by *file name* (rows in
 * `d1_migrations`). That is not enough for InboxAngel installs that predate the
 * single migration path:
 *
 *  - three different migrations have been named `0005_*` (`0005_add_is_default`
 *    was renamed to `0006_add_is_default` in a merge), so an install can hold a
 *    row for a name that no longer exists and would re-run the renamed file;
 *  - `ensureMigrated()` used to create tables and columns at runtime, so the
 *    effects of some migrations exist with no row in `d1_migrations` at all;
 *  - SQLite has no `ADD COLUMN IF NOT EXISTS`, so re-running any of those
 *    `ALTER`s fails with "duplicate column name" and aborts the whole upgrade.
 *
 * So before `wrangler d1 migrations apply`, we look at what the database
 * *actually has* and record, in `d1_migrations`, every migration whose effect is
 * already present. Name-independent, idempotent, and a no-op on fresh installs.
 */

interface ColumnRule {
	/** Migration file whose only effect is to add these columns. */
	file: string;
	table: string;
	/** Column name → DDL that adds it (used to repair a half-applied migration). */
	columns: Record<string, string>;
}

export const ADOPTION_RULES: readonly ColumnRule[] = [
	{ file: '0002_add_dns_record_id.sql', table: 'domains', columns: { dns_record_id: 'TEXT' } },
	{ file: '0003_check_session_token.sql', table: 'check_results', columns: { session_token: 'TEXT' } },
	{
		file: '0005_rollout_stage.sql',
		table: 'domains',
		columns: { rollout_rec_policy: 'TEXT', rollout_rec_pct: 'INTEGER' },
	},
	{
		file: '0005_subdomain_parent.sql',
		table: 'domains',
		columns: { parent_id: 'INTEGER REFERENCES domains(id) ON DELETE SET NULL' },
	},
	{
		file: '0006_add_is_default.sql',
		table: 'domains',
		columns: { is_default: 'INTEGER NOT NULL DEFAULT 0' },
	},
	{ file: '0008_domains_alerts_enabled.sql', table: 'domains', columns: { alerts_enabled: 'INTEGER NOT NULL DEFAULT 1' } },
	{ file: '0009_domains_spf_lookup_count.sql', table: 'domains', columns: { spf_lookup_count: 'INTEGER' } },
	{
		file: '0010_check_results_spf_lookup_count.sql',
		table: 'check_results',
		columns: { spf_lookup_count: 'INTEGER' },
	},
	{
		file: '0011_report_records_enrichment.sql',
		table: 'report_records',
		columns: { reverse_dns: 'TEXT', base_domain: 'TEXT', country_code: 'TEXT', org: 'TEXT' },
	},
];

/** Rows: `{ tbl, col }` for every column of every user table. */
export const INTROSPECT_COLUMNS_SQL =
	"SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p " +
	"WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'";

export const D1_MIGRATIONS_DDL =
	'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
	'name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

export interface AdoptionPlan {
	/** Statements to run (repairs, then bookkeeping). Empty when nothing to adopt. */
	statements: string[];
	/** Migration files recorded as already applied. */
	adopted: string[];
}

/**
 * @param columns  table name → column names currently present
 * @param applied  names already in `d1_migrations`
 */
export function planAdoption(columns: Record<string, string[]>, applied: Iterable<string>): AdoptionPlan {
	const done = new Set(applied);
	const repairs: string[] = [];
	const adopted: string[] = [];

	for (const rule of ADOPTION_RULES) {
		if (done.has(rule.file)) continue;
		const have = new Set(columns[rule.table] ?? []);
		const names = Object.keys(rule.columns);
		const present = names.filter((c) => have.has(c));
		if (present.length === 0) continue; // genuinely unapplied: let wrangler run it
		for (const c of names) {
			if (!have.has(c)) repairs.push(`ALTER TABLE ${rule.table} ADD COLUMN ${c} ${rule.columns[c]}`);
		}
		adopted.push(rule.file);
	}

	if (adopted.length === 0) return { statements: [], adopted };
	const quoted = adopted.map((f) => `('${f}')`).join(', ');
	return {
		statements: [...repairs, D1_MIGRATIONS_DDL, `INSERT OR IGNORE INTO d1_migrations (name) VALUES ${quoted}`],
		adopted,
	};
}

export function groupColumns(rows: Array<{ tbl: string; col: string }>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const { tbl, col } of rows) (out[tbl] ??= []).push(col);
	return out;
}
