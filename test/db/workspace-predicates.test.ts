import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WORKSPACE_OWNED_TABLES, GLOBAL_TABLES } from '@inbox-angel/db';

/**
 * Static guard: every query on a tenant-owned table, in the Worker (src/) and the
 * query layer, must carry a workspace predicate **on that table's workspace_id**,
 * checked per SQL statement and per Drizzle chain (not per file or method).
 *
 *  - SQL (any string/template literal, split on `;`): for each `FROM|JOIN|UPDATE|DELETE FROM <owned> [alias]`
 *    the statement needs `alias.workspace_id = / IN` (bare `workspace_id =` when unaliased);
 *    `INSERT INTO <owned>` needs `workspace_id` in its column list.
 *  - Drizzle chains (`db.select|insert|update|delete(...)...`, comments stripped): for each owned table the chain
 *    touches it needs `eq(<table>.workspace_id, x)`, an `workspace_id:` value on insert, or a predicate helper
 *    (`const mine = eq(<table>.workspace_id, workspaceId)`) *used in that chain*.
 *  - Global tables are allow-listed (schema.ts GLOBAL_TABLES); unknown tables fail.
 *  - A chain may opt out with an `workspace-scope-exempt: <reason>` comment inside it; the count is pinned below.
 */

const ROOT = join(import.meta.dirname, '../..');
const OWNED = new Set<string>(WORKSPACE_OWNED_TABLES);
const GLOBAL = new Set<string>(Object.keys(GLOBAL_TABLES));
const BOOKKEEPING = new Set(['d1_migrations', '_migrations']);
const KEYWORDS = new Set(['where', 'on', 'set', 'values', 'select', 'group', 'order', 'limit', 'left', 'inner', 'join', 'using', 'as', 'returning', 'and', 'or', 'cross']);

const TABLE_VARS: Record<string, string> = {
	products: 'products', productDomains: 'product_domains', accessPrincipals: 'access_principals', accessGrants: 'access_grants', accessCredentials: 'access_credentials',
	domains: 'domains', aggregateReports: 'aggregate_reports', reportRecords: 'report_records', tlsReports: 'tls_reports',
	spfFlattenConfig: 'spf_flatten_config', mtaStsConfig: 'mta_sts_config', monitorSubscriptions: 'monitor_subscriptions',
	settings: 'settings', invites: 'invites', auditLog: 'audit_log', memberships: 'memberships', apiKeys: 'api_keys',
	intakeTokens: 'intake_tokens', hostedDomains: 'hosted_domains', cloudflareConnections: 'cloudflare_connections', cloudflareConnectionZones: 'cloudflare_connection_zones', cloudflareConnectionBlockedZones: 'cloudflare_connection_blocked_zones',
};

interface Hit { table: string; problem: string }

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
	});
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function literals(src: string): string[] {
	const re = /(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g;
	return [...src.matchAll(re)].map((m) => m[1]);
}

export function checkSql(lit: string): Hit[] {
	const hits: Hit[] = [];
	for (const stmt of lit.split(';')) {
		const re = /\b(FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
		for (const m of stmt.matchAll(re)) {
			const kw = m[1].toUpperCase();
			const table = m[2].toLowerCase();
			let alias = m[3]?.toLowerCase();
			if (alias && KEYWORDS.has(alias)) alias = undefined;
			if (BOOKKEEPING.has(table) || GLOBAL.has(table)) continue;
			if (!OWNED.has(table)) {
				if (/^[`'"]?\s*(select|insert|update|delete|with)\b/i.test(stmt)) hits.push({ table, problem: 'table is in neither WORKSPACE_OWNED_TABLES nor GLOBAL_TABLES' });
				continue;
			}
			if (kw === 'INTO') {
				const cols = stmt.slice(m.index! + m[0].length - (m[3] ? m[3].length : 0)).match(/^\s*\(([^)]*)\)/);
				if (!cols || !/\bworkspace_id\b/i.test(cols[1])) hits.push({ table, problem: 'INSERT without workspace_id column' });
				continue;
			}
			const ref = alias ?? table;
			const pred = alias
				? new RegExp(`\\b${alias}\\.workspace_id\\s*(=|IN\\b)`, 'i')
				: new RegExp(`(?<![.\\w])workspace_id\\s*(=|IN\\b)|\\b${table}\\.workspace_id\\s*(=|IN\\b)`, 'i');
			if (!pred.test(stmt)) hits.push({ table, problem: `no ${ref}.workspace_id predicate` });
		}
	}
	return hits;
}

/** Text of each `db.select|insert|update|delete(...)` call chain (paren-balanced). */
function chains(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/\bdb\s*\.\s*(?:select|selectDistinct|insert|update|delete)\s*\(/g)) {
		let i = m.index! + m[0].length - 1;
		for (;;) {
			let depth = 0;
			for (; i < src.length; i++) {
				if (src[i] === '(') depth++;
				else if (src[i] === ')' && --depth === 0) { i++; break; }
			}
			const rest = src.slice(i).match(/^\s*\.\s*[A-Za-z_$][\w$]*\s*(?:<[^>(]*>)?\s*\(/);
			if (!rest) break;
			i += rest[0].length - 1;
		}
		out.push(src.slice(m.index!, i));
	}
	return out;
}

export function checkBuilder(raw: string): Hit[] {
	const hits: Hit[] = [];
	const src = stripComments(raw);
	// predicate helpers: `const mine = eq(T.workspace_id, workspaceId)` and `const f = (..) => and(mine, ...)`
	const helpers: Array<[string, string]> = []; // [helper name, table var] (names like `mine` repeat per table)
	for (const m of src.matchAll(/const (\w+) = (?:\([^\n]*?\) => and\()?eq\((\w+)\.workspace_id,\s*\w+\)/g)) helpers.push([m[1], m[2]]);
	for (const m of src.matchAll(/const (\w+) = ([^\n]*)/g)) {
		if (!/\band\(/.test(m[2])) continue;
		for (const [h, t] of [...helpers]) if (new RegExp(`\\b${h}\\b`).test(m[2]) && !helpers.some(([n, tt]) => n === m[1] && tt === t)) helpers.push([m[1], t]);
	}
	const exempt = new Set<string>();
	for (const chainSrc of chainsWithComments(raw)) if (/workspace-scope-exempt:/.test(chainSrc)) exempt.add(stripComments(chainSrc));
	for (const chain of chains(src)) {
		if (exempt.has(chain)) continue;
		const tables = new Set<string>();
		for (const m of chain.matchAll(new RegExp(`\\.(?:from|update|delete|insert|innerJoin|leftJoin|rightJoin)\\(\\s*(${Object.keys(TABLE_VARS).join('|')})\\b`, 'g'))) tables.add(m[1]);
		for (const t of tables) {
			const direct = new RegExp(`\\beq\\(\\s*${t}\\.workspace_id\\s*,\\s*\\w+\\s*\\)|\\bworkspace_id\\s*:\\s*\\w+`).test(chain);
			const viaHelper = helpers.some(([h, ht]) => ht === t && new RegExp(`\\b${h}\\b`).test(chain));
			if (!direct && !viaHelper) hits.push({ table: TABLE_VARS[t], problem: `drizzle chain without ${t}.workspace_id predicate: ${chain.slice(0, 80).replace(/\s+/g, ' ')}` });
		}
	}
	return hits;
}

/** Same chains, but taken from the comment-preserving source (for exemption markers). */
function chainsWithComments(raw: string): string[] {
	return chains(raw);
}

export function checkSource(raw: string): Hit[] {
	return [...literals(stripComments(raw)).flatMap(checkSql), ...checkBuilder(raw)];
}

function scan(files: string[]) {
	const found: string[] = [];
	let exemptions = 0;
	for (const file of files) {
		const raw = readFileSync(file, 'utf8');
		exemptions += (raw.match(/workspace-scope-exempt:/g) ?? []).length;
		for (const h of checkSource(raw)) found.push(`${relative(ROOT, file)}: ${h.table} — ${h.problem}`);
	}
	return { found, exemptions };
}

describe('every query on tenant data carries a workspace predicate (per statement / chain)', () => {
	it('src/ has no unscoped SQL or query chains on workspace-owned tables', () => {
		expect(scan(walk(join(ROOT, 'src'))).found).toEqual([]);
	});

	it('the query layer (except global.ts) is scoped, with the documented exemptions (one elsewhere, one in funnel.ts: an unsubscribe removes the address from every workspace, three in workspaces.ts: a user own workspaces and routing by reports domain / hostname, six in auth.ts: resolving a credential to its workspace, four in intake.ts: resolving a report token / hosted id, five in claims.ts: who verified a domain first, finding and detaching an unproven holder; four in access-grants.ts: credential id/hash, principal identity and finite portfolio consent)', () => {
		const files = walk(join(ROOT, 'packages/db/src/queries')).filter((f) => !/global(-lifecycle)?\.ts$/.test(f));
		expect(files.length).toBeGreaterThan(5);
		const { found, exemptions } = scan(files);
		expect(found).toEqual([]);
		expect(exemptions).toBe(25);
	});

	it('pins the privileged access lookup census without exempting scoped access queries', () => {
		const raw = readFileSync(join(ROOT, 'packages/db/src/queries/access-grants.ts'), 'utf8');
		const [lookups, scoped] = raw.split('export function accessQueries');
		expect(lookups).toContain('export function accessLookups');
		const privileged = chains(lookups).filter(chain => /workspace-scope-exempt:/.test(chain));
		expect(privileged).toHaveLength(5);
		for (const [table, field] of [['accessCredentials', 'id'], ['accessCredentials', 'key_hash'], ['accessPrincipals', 'id'], ['accessGrants', 'principal_id']]) {
			expect(privileged.filter(chain => chain.includes(`eq(${table}.${field},`))).toHaveLength(1);
		}
		expect(privileged.filter(chain => chain.includes('eq(accessPrincipals.user_id, userId)') && chain.includes("eq(accessPrincipals.kind, 'human')"))).toHaveLength(1);
		expect(scoped).toBeTruthy();
		expect(scoped).not.toContain('workspace-scope-exempt:');
		expect(checkSource(raw)).toEqual([]);
	});

	it('global.ts only touches allow-listed global tables', () => {
		const src = stripComments(readFileSync(join(ROOT, 'packages/db/src/queries/global.ts'), 'utf8'));
		const used = [...src.matchAll(/\.(?:from|update|delete|insert)\((\w+)\)/g)].map((m) => m[1]);
		expect(used.length).toBeGreaterThan(0);
		const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
		for (const t of used) expect(GLOBAL.has(snake(t)), `${t} is not in GLOBAL_TABLES`).toBe(true);
	});

	it('the allow-list matches the schema', () => {
		for (const t of GLOBAL) expect(OWNED.has(t)).toBe(false);
		expect([...GLOBAL].sort()).toEqual(['auth_accounts', 'auth_rate_limits', 'canary_tokens', 'check_results', 'hosted_zones', 'ip_info', 'leads', 'password_reset_tokens', 'revocation_tombstones', 'sessions', 'suppression', 'users', 'verifications', 'workspaces']);
	});
});

describe('negative cases: each of these must fail the check', () => {
	it('1. the word "mine" in a comment is not a predicate', () => {
		const src = `const mine = eq(domains.workspace_id, workspaceId);\nexport const q = {\n\t\tlist() {\n\t\t\t// mine\n\t\t\treturn db.select().from(domains).all();\n\t\t},\n};`;
		expect(checkSource(src)).toHaveLength(1);
	});

	it('2. an unused workspaceId local is not a predicate', () => {
		const src = `export const q = (db: any, workspaceId: string) => {\n\tconst id = workspaceId;\n\treturn db.select().from(domains).where(eq(domains.id, 1)).all();\n};`;
		expect(checkSource(src)).toHaveLength(1);
	});

	it('3. raw SQL that merely selects workspace_id has no predicate', () => {
		expect(checkSql('SELECT workspace_id, domain FROM domains WHERE id = ?')).toHaveLength(1);
		expect(checkSql('SELECT d.workspace_id FROM domains d WHERE d.id = ?')).toHaveLength(1);
		expect(checkSql('SELECT domain FROM domains WHERE workspace_id = ? AND id = ?')).toEqual([]);
	});

	it('4. a method with one scoped and one unscoped chain fails', () => {
		const src = `const mine = eq(domains.workspace_id, workspaceId);\nexport const q = {\n\t\ttwo() {\n\t\t\tconst a = db.select().from(domains).where(mine).all();\n\t\t\tconst b = db.select().from(domains).where(eq(domains.id, 1)).all();\n\t\t\treturn [a, b];\n\t\t},\n};`;
		const hits = checkSource(src);
		expect(hits).toHaveLength(1);
		expect(hits[0].problem).toMatch(/drizzle chain/);
	});
});

describe('positive cases and other shapes', () => {
	it('accepts scoped chains, helpers used in the chain, and inserts with workspace_id', () => {
		expect(checkSource(`const mine = eq(domains.workspace_id, workspaceId);\nconst x = db.select().from(domains).where(and(mine, eq(domains.id, 1))).get();`)).toEqual([]);
		expect(checkSource(`const x = db.delete(domains).where(and(eq(domains.workspace_id, workspaceId), eq(domains.id, 1)));`)).toEqual([]);
		expect(checkSource(`const x = db.insert(domains).values({ ...r, workspace_id: workspaceId }).run();`)).toEqual([]);
	});

	it('flags unscoped insert/update/delete and a wrong-table predicate', () => {
		expect(checkSource(`db.insert(domains).values({ domain: 'x' }).run();`)).toHaveLength(1);
		expect(checkSource(`db.update(domains).set({ a: 1 }).where(eq(domains.id, 1));`)).toHaveLength(1);
		expect(checkSource(`db.select().from(domains).innerJoin(aggregateReports, eq(aggregateReports.domain_id, domains.id)).where(eq(domains.workspace_id, workspaceId));`)).toHaveLength(1);
		expect(checkSql('INSERT INTO audit_log (action) VALUES (?)')).toHaveLength(1);
		expect(checkSql('INSERT INTO audit_log (workspace_id, action) VALUES (?, ?)')).toEqual([]);
		expect(checkSql('UPDATE domains SET is_default = 0')).toHaveLength(1);
		expect(checkSql('DELETE FROM settings WHERE key = ?; DELETE FROM domains WHERE workspace_id = ?')).toHaveLength(1);
	});

	it('every owned alias in a join needs its own predicate; globals and unknown tables', () => {
		expect(checkSql('SELECT r.* FROM aggregate_reports r JOIN domains d ON d.id = r.domain_id WHERE r.workspace_id = ?')).toEqual([{ table: 'domains', problem: 'no d.workspace_id predicate' }]);
		expect(checkSql('SELECT r.* FROM aggregate_reports r JOIN domains d ON d.id = r.domain_id WHERE r.workspace_id = ? AND d.workspace_id = ?')).toEqual([]);
		expect(checkSql('SELECT * FROM ip_info WHERE ip = ?')).toEqual([]);
		expect(checkSql('SELECT * FROM brand_new_table WHERE id = ?')).toHaveLength(1);
		expect(checkSql('some prose: data from the table')).toEqual([]);
	});

	it('access tables are checked individually, including joins and wrong-table predicates', () => {
		for (const t of ['products', 'productDomains', 'accessPrincipals', 'accessGrants', 'accessCredentials']) {
			expect(checkSource(`db.select().from(${t}).all();`)).toHaveLength(1);
			expect(checkSource(`db.select().from(${t}).where(eq(domains.workspace_id, workspaceId)).all();`)).toHaveLength(1);
			expect(checkSource(`db.select().from(${t}).where(eq(${t}.workspace_id, workspaceId)).all();`)).toEqual([]);
		}
	});

	it('honours a workspace-scope-exempt marker inside a chain', () => {
		expect(checkSource(`db.select().from(memberships).where(eq(memberships.user_id, 1)); `)).toHaveLength(1);
		expect(checkSource(`db.select().from(memberships /* workspace-scope-exempt: x */).where(eq(memberships.user_id, 1));`)).toEqual([]);
	});
});
