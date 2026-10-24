/**
 * Runtime guard that replaces the old ensureMigrated(): the Worker no longer
 * changes the schema, it only checks that `wrangler d1 migrations apply` has
 * been run, and says so clearly if not.
 */

/** The newest migration this build of the code depends on. Bump with every new migration. */
export const REQUIRED_MIGRATION = '0005_trust_followups.sql';

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
		row = await db.prepare('SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?').bind(REQUIRED_MIGRATION).first<{ n: number }>();
	} catch {
		throw new SchemaNotReadyError('no migration history found');
	}
	if (!row || row.n === 0) throw new SchemaNotReadyError(`${REQUIRED_MIGRATION} has not been applied`);
	verified = true;
}

/** Test hook. */
export function resetSchemaReadyCache() {
	verified = false;
}
