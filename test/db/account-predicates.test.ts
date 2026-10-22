import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ACCOUNT_OWNED_TABLES, GLOBAL_TABLES } from '@inbox-angel/db';

/**
 * Static guard: no SQL in the Worker (src/) or in the query layer may touch a
 * tenant-owned table without an account predicate. Global tables are allow-listed
 * explicitly (schema.ts GLOBAL_TABLES); any table that is in neither list fails.
 *
 * It is deliberately grep-shaped, not a SQL parser: it finds `FROM|JOIN|INTO|UPDATE|
 * DELETE FROM <table> [alias]` inside string literals and requires `<alias>.account_id`
 * (or a bare `account_id` when there is no alias) in the same literal. Drizzle builder
 * chains (`.from(domains)` …) must mention the account somewhere in the same method
 * (heuristic; the behavioural cross-account tests in packages/db/test/queries.test.ts are the real proof).
 */

const ROOT = join(import.meta.dirname, '../..');
const OWNED = new Set<string>(ACCOUNT_OWNED_TABLES);
const GLOBAL = new Set<string>(Object.keys(GLOBAL_TABLES));
/** Tables that exist only as migration bookkeeping. */
const BOOKKEEPING = new Set(['d1_migrations', '_migrations']);

/** Explicit, justified exceptions: `${relative path}:${table}`. Keep empty if you can. */
const UNSCOPED_ALLOWED: Record<string, string> = {};

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
	});
}

/** All string/template literals in a source file (good enough: no regex literals with quotes in these files). */
function literals(src: string): string[] {
	const out: string[] = [];
	const re = /(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g;
	for (const m of src.matchAll(re)) out.push(m[1]);
	return out;
}

const KEYWORDS = new Set(['where', 'on', 'set', 'values', 'select', 'group', 'order', 'limit', 'left', 'inner', 'join', 'using', 'as', 'returning', 'and', 'or']);

interface Hit { table: string; problem: string }

export function checkSql(lit: string): Hit[] {
	const hits: Hit[] = [];
	const re = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
	for (const m of lit.matchAll(re)) {
		const table = m[1].toLowerCase();
		let alias = m[2]?.toLowerCase();
		if (alias && KEYWORDS.has(alias)) alias = undefined;
		if (BOOKKEEPING.has(table) || GLOBAL.has(table)) continue;
		if (!OWNED.has(table)) {
			// Not a table we know (e.g. `FROM (` subquery, prose in a comment, JSON text): only flag real-looking SQL.
			if (/^(select|insert|update|delete|with)\b/i.test(lit.replace(/^[`'"]\s*/, ''))) hits.push({ table, problem: 'table is in neither ACCOUNT_OWNED_TABLES nor GLOBAL_TABLES' });
			continue;
		}
		const ref = alias ?? table;
		const scoped = new RegExp(`\\b${ref}\\.account_id\\b`, 'i').test(lit) || (!alias && /\baccount_id\b/i.test(lit));
		if (!scoped) hits.push({ table, problem: `no ${ref}.account_id predicate` });
	}
	return hits;
}

const TABLE_VARS: Record<string, string> = {
	domains: 'domains', aggregateReports: 'aggregate_reports', reportRecords: 'report_records', tlsReports: 'tls_reports',
	spfFlattenConfig: 'spf_flatten_config', mtaStsConfig: 'mta_sts_config', monitorSubscriptions: 'monitor_subscriptions',
	settings: 'settings', invites: 'invites', auditLog: 'audit_log', memberships: 'memberships',
};

/** Drizzle chains on owned tables must mention the account within the same method body. */
export function checkBuilder(src: string): Hit[] {
	const hits: Hit[] = [];
	const lines = src.split('\n');
	const text = lines.join('\n');
	const re = new RegExp(`\\.(?:from|update|delete|insert|innerJoin|leftJoin)\\((${Object.keys(TABLE_VARS).join('|')})\\b`, 'g');
	for (const m of text.matchAll(re)) {
		const start = m.index!;
		// Window: the whole method (methods start/end on lines indented exactly two tabs), so a
		// predicate built into a `where` array before the chain counts.
		const before = text.slice(0, start);
		const starts = [...before.matchAll(/\n\t\t[A-Za-z]/g)];
		const methodStart = starts.length ? starts[starts.length - 1].index! : 0;
		const rest = text.slice(start);
		const end = rest.search(/\n\t\t(?:[A-Za-z]|\})/);
		const window = text.slice(methodStart, end === -1 ? text.length : start + end);
		if (!/\baccount_id\b|\baccountId\b|\bmine\b|\bforDomain\b/.test(window)) hits.push({ table: TABLE_VARS[m[1]], problem: `drizzle chain without account predicate near: ${rest.slice(0, 70).replace(/\s+/g, ' ')}` });
	}
	// The shared predicate helpers themselves must be account predicates.
	for (const d of text.matchAll(/const (mine|forDomain) = ([^\n]*)/g)) {
		if (!/account_id/.test(d[2]) && !/mine/.test(d[2])) hits.push({ table: '?', problem: `helper ${d[1]} does not reference account_id` });
	}
	return hits;
}

function scan(files: string[], builder: boolean) {
	const found: string[] = [];
	for (const file of files) {
		const rel = relative(ROOT, file);
		const src = readFileSync(file, 'utf8');
		const hits = [...literals(src).flatMap(checkSql), ...(builder ? checkBuilder(src) : [])];
		for (const h of hits) if (!UNSCOPED_ALLOWED[`${rel}:${h.table}`]) found.push(`${rel}: ${h.table} — ${h.problem}`);
	}
	return found;
}

describe('every query on tenant data carries an account predicate', () => {
	it('src/ contains no unscoped SQL on account-owned tables', () => {
		expect(scan(walk(join(ROOT, 'src')), false)).toEqual([]);
	});

	it('the query layer (packages/db/src/queries, except global.ts) is scoped', () => {
		const files = walk(join(ROOT, 'packages/db/src/queries')).filter((f) => !f.endsWith('global.ts'));
		expect(files.length).toBeGreaterThan(5);
		expect(scan(files, true)).toEqual([]);
	});

	it('global.ts only touches allow-listed global tables', () => {
		const src = readFileSync(join(ROOT, 'packages/db/src/queries/global.ts'), 'utf8');
		const used = [...src.matchAll(/\.(?:from|update|delete|insert)\((\w+)\)/g)].map((m) => m[1]);
		expect(used.length).toBeGreaterThan(0);
		const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
		for (const t of used) expect(GLOBAL.has(camelToSnake(t)), `${t} is not in GLOBAL_TABLES`).toBe(true);
	});

	it('the allow-list matches the schema (every global table really has no account_id)', () => {
		for (const t of GLOBAL) expect(OWNED.has(t)).toBe(false);
		expect([...GLOBAL].sort()).toEqual(['accounts', 'check_results', 'ip_info', 'password_reset_tokens', 'users']);
	});
});

describe('the guard itself catches violations', () => {
	it('flags raw SQL without a predicate', () => {
		expect(checkSql('SELECT * FROM domains WHERE id = ?')).toHaveLength(1);
		expect(checkSql('UPDATE domains SET is_default = 0')).toHaveLength(1);
		expect(checkSql('DELETE FROM settings WHERE key = ?')).toHaveLength(1);
		expect(checkSql('INSERT INTO audit_log (action) VALUES (?)')).toHaveLength(1);
		expect(checkSql('SELECT r.* FROM aggregate_reports r JOIN domains d ON d.id = r.domain_id WHERE r.account_id = ?')).toEqual([
			{ table: 'domains', problem: 'no d.account_id predicate' },
		]);
	});

	it('accepts scoped SQL and global tables', () => {
		expect(checkSql('SELECT * FROM domains WHERE account_id = ? AND id = ?')).toEqual([]);
		expect(checkSql('SELECT r.* FROM aggregate_reports r JOIN domains d ON d.id = r.domain_id WHERE r.account_id = ? AND d.account_id = ?')).toEqual([]);
		expect(checkSql('SELECT * FROM ip_info WHERE ip = ?')).toEqual([]);
		expect(checkSql('SELECT * FROM check_results WHERE session_token = ?')).toEqual([]);
		expect(checkSql('SELECT * FROM password_reset_tokens WHERE token = ?')).toEqual([]);
		expect(checkSql('SELECT * FROM users WHERE email = ?')).toEqual([]);
	});

	it('flags unknown tables that look like real SQL', () => {
		expect(checkSql('SELECT * FROM brand_new_table WHERE id = ?')).toHaveLength(1);
		expect(checkSql('some prose: data from the table')).toEqual([]);
	});

	it('flags drizzle chains without an account', () => {
		const bad = `export const q = {\n\t\tlist() {\n\t\t\treturn db.select().from(domains).all();\n\t\t},\n};`;
		expect(checkBuilder(bad)).toHaveLength(1);
		const good = `export const q = {\n\t\tlist() {\n\t\t\treturn db.select().from(domains).where(eq(domains.account_id, accountId)).all();\n\t\t},\n};`;
		expect(checkBuilder(good)).toEqual([]);
	});
});
