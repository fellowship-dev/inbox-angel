import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestD1 } from '../src/testing';
import { freshDb, schemaSnapshot } from './helpers';

/**
 * drizzle-kit's own rendering of schema.ts (packages/db/drizzle/0000_baseline.sql,
 * regenerate with `npm run db:generate`) must produce the same database as the
 * hand-reviewed /migrations history. Catches schema.ts edits without a migration,
 * and migrations that diverge from schema.ts.
 */
describe('drizzle-kit output vs migrations', () => {
	it('creates the same schema as applying every migration', () => {
		const sql = readFileSync(join(import.meta.dirname, '../drizzle/0000_baseline.sql'), 'utf8');
		const d = createTestD1();
		for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) d.sqlite.exec(stmt);
		expect(schemaSnapshot(d.sqlite)).toEqual(schemaSnapshot(freshDb().sqlite));
	});
});
