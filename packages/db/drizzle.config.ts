import { defineConfig } from 'drizzle-kit';

/**
 * `npm run db:generate` diffs schema.ts against the last snapshot in ./drizzle and
 * writes the SQL for the change there. Review it, add any backfill, and move it to
 * /migrations/NNNN_name.sql (the directory wrangler applies). The drift test in
 * test/schema-drift.test.ts fails if schema.ts and /migrations disagree.
 */
export default defineConfig({
	dialect: 'sqlite',
	schema: './packages/db/src/schema.ts',
	out: './packages/db/drizzle',
});
