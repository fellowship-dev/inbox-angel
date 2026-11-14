/**
 * Runtime guard that replaces the old ensureMigrated(): the Worker no longer
 * changes the schema, it only checks that `wrangler d1 migrations apply` has
 * been run, and says so clearly if not.
 */

/**
 * The specific migrations this build of the code needs, by file name. The guard checks that EACH of them is recorded in `d1_migrations`; it does
 * not require a contiguous sequence and does not look at "the latest": a gap (one applied later, or never, by a branch that is not merged) and
 * newer migrations from other branches are fine. Add a name here when code starts to depend on a new migration; never remove one.
 */
export const REQUIRED_MIGRATIONS: readonly string[] = ['0010_intake_hardening.sql', '0012_dmarc_enforcement.sql'];

/** The newest of the required migrations (kept for callers that name one). */
export const REQUIRED_MIGRATION = REQUIRED_MIGRATIONS[REQUIRED_MIGRATIONS.length - 1];

export class SchemaNotReadyError extends Error {
	constructor(detail: string) {
		super(
			`Database schema is out of date (${detail}). Run \`npm run migrate\` ` +
				`(wrangler d1 migrations apply) before serving traffic. See packages/db/UPGRADING.md.`,
		);
		this.name = 'SchemaNotReadyError';
	}
}

let verified = false;

/** Cheap, cached per isolate once it succeeds. Throws SchemaNotReadyError. */
export async function assertSchemaReady(db: D1Database): Promise<void> {
	if (verified) return;
	let row: { n: number } | null;
	try {
		row = await db.prepare(`SELECT COUNT(*) AS n FROM d1_migrations WHERE name IN (${REQUIRED_MIGRATIONS.map(() => '?').join(', ')})`).bind(...REQUIRED_MIGRATIONS).first<{ n: number }>();
	} catch {
		throw new SchemaNotReadyError('no migration history found');
	}
	if (!row || row.n < REQUIRED_MIGRATIONS.length) throw new SchemaNotReadyError(`${REQUIRED_MIGRATIONS.join(', ')} ${REQUIRED_MIGRATIONS.length === 1 ? 'has' : 'have'} not been applied`);
	verified = true;
}

/** Test hook. */
export function resetSchemaReadyCache() {
	verified = false;
}
