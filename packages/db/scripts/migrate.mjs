#!/usr/bin/env node
/**
 * `npm run migrate` — the one way to move an InboxAngel database forward.
 *
 *   node packages/db/scripts/migrate.mjs [--local | --remote] [--dry-run] [--db <binding-or-name>] [--persist-to <dir>]
 *
 * 1. Looks at the database and records, in wrangler's `d1_migrations` table, every
 *    migration whose effect is already present (installs that predate the single
 *    migration path, or that ran a since-renamed 0005_* file). See src/adopt.ts.
 * 2. Runs `wrangler d1 migrations apply`.
 *
 * On a fresh database step 1 does nothing. Requires Node >= 22.18 (it imports the
 * TypeScript source directly).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = args.includes('--local') ? '--local' : '--remote';
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const DB = dbIdx >= 0 ? args[dbIdx + 1] : 'DB';
const persistIdx = args.indexOf('--persist-to');
// Local only: keep the miniflare database somewhere other than .wrangler/ (used by tests).
const persist = persistIdx >= 0 ? ['--persist-to', args[persistIdx + 1]] : [];

let adopt;
try {
	adopt = await import('../src/adopt.ts');
} catch (e) {
	console.error(`Cannot load packages/db/src/adopt.ts (needs Node >= 22.18): ${e.message}`);
	process.exit(1);
}

function wrangler(extra, { allowFail = false } = {}) {
	const r = spawnSync('npx', ['wrangler', ...extra], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
	if (r.status !== 0 && !allowFail) {
		process.stderr.write(r.stdout + r.stderr);
		process.exit(r.status ?? 1);
	}
	return r;
}

function query(sql, opts) {
	const r = wrangler(['d1', 'execute', DB, flag, ...persist, '--json', '--command', sql], opts);
	if (r.status !== 0) return null;
	// wrangler prints progress lines before the JSON on some versions
	const start = r.stdout.indexOf('[');
	return JSON.parse(r.stdout.slice(start))[0]?.results ?? [];
}

console.log(`Checking ${flag.slice(2)} database '${DB}'…`);
const columns = adopt.groupColumns(query(adopt.INTROSPECT_COLUMNS_SQL));
const applied = (query('SELECT name FROM d1_migrations', { allowFail: true }) ?? []).map((r) => r.name);
const plan = adopt.planAdoption(columns, applied);

if (plan.statements.length === 0) {
	console.log('Nothing to adopt — migration history already matches the database.');
} else {
	console.log('This database already contains the effects of:\n  ' + plan.adopted.join('\n  '));
	console.log('Recording them in d1_migrations so they are not run twice:\n  ' + plan.statements.join(';\n  ') + ';');
	if (!dryRun) {
		const dir = mkdtempSync(join(tmpdir(), 'ia-adopt-'));
		const file = join(dir, 'adopt.sql');
		writeFileSync(file, plan.statements.join(';\n') + ';\n');
		try {
			wrangler(['d1', 'execute', DB, flag, ...persist, '--yes', '--file', file]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

if (dryRun) {
	console.log('--dry-run: not applying migrations.');
	process.exit(0);
}

const apply = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', DB, flag, ...persist], { stdio: 'inherit' });
process.exit(apply.status ?? 1);
