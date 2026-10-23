#!/usr/bin/env node
/**
 * `npm run migrate` — the one way to move an InboxAngel database forward.
 *
 *   node packages/db/scripts/migrate.mjs [--local | --remote] [--db <binding-or-name>] [--persist-to <dir>]
 *
 * A thin wrapper over `wrangler d1 migrations apply`: unapplied files in /migrations run in
 * name order, each in one transaction, and are recorded by name in `d1_migrations`.
 * The Worker refuses to serve until the newest one (REQUIRED_MIGRATION) is recorded.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = args.includes('--local') ? '--local' : '--remote';
const dbIdx = args.indexOf('--db');
const DB = dbIdx >= 0 ? args[dbIdx + 1] : 'DB';
const persistIdx = args.indexOf('--persist-to');
// Local only: keep the miniflare database somewhere other than .wrangler/ (used by tests).
const persist = persistIdx >= 0 ? ['--persist-to', args[persistIdx + 1]] : [];

const apply = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', DB, flag, ...persist], { stdio: 'inherit' });
process.exit(apply.status ?? 1);
