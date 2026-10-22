export { createTestD1, type TestD1 } from './d1-sqlite';
export { applyMigrations, adopt, appliedMigrations, migrationFiles, MIGRATIONS_DIR } from './migrate';
import { createTestD1 } from './d1-sqlite';
import { applyMigrations } from './migrate';

/** A fresh in-memory D1 with every migration applied. */
export function createMigratedD1() {
	const db = createTestD1();
	applyMigrations(db.sqlite);
	return db;
}
