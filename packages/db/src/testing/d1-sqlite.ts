/**
 * A D1Database look-alike over `node:sqlite`, for tests (Node ≥ 22.5).
 * Mirrors the D1 surface the app and Drizzle use: prepare/bind/run/all/first/raw
 * and atomic batch. Foreign keys are ON, as in D1.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

type Row = Record<string, unknown>;

class Statement {
	constructor(
		private readonly db: DatabaseSync,
		readonly sql: string,
		private params: unknown[] = [],
	) {}

	bind(...params: unknown[]) {
		return new Statement(this.db, this.sql, params);
	}

	private stmt() {
		const s = this.db.prepare(this.sql);
		s.setReadBigInts(false);
		return s;
	}
	private args() {
		return this.params.map((p) => (p === undefined ? null : p)) as SQLInputValue[];
	}

	async run() {
		const r = this.stmt().run(...this.args());
		return {
			success: true,
			results: [] as Row[],
			meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_written: Number(r.changes) },
		};
	}
	async all<T = Row>() {
		const results = this.stmt().all(...this.args()).map((r) => ({ ...r })) as T[];
		return { success: true, results, meta: { changes: 0 } };
	}
	async first<T = Row>(col?: string) {
		const row = this.stmt().get(...this.args());
		if (!row) return null as T | null;
		return (col ? (row as Row)[col] : { ...row }) as T;
	}
	async raw<T = unknown[]>() {
		const s = this.stmt();
		s.setReturnArrays(true);
		return s.all(...this.args()) as unknown as T[];
	}
}

export interface TestD1 extends D1Database {
	/** The underlying connection, for assertions and fixtures. */
	readonly sqlite: DatabaseSync;
}

export function createTestD1(sqlite = new DatabaseSync(':memory:')): TestD1 {
	sqlite.exec('PRAGMA foreign_keys = ON');
	const db = {
		sqlite,
		prepare: (sql: string) => new Statement(sqlite, sql),
		async batch(stmts: Statement[]) {
			sqlite.exec('BEGIN');
			try {
				const out = [];
				for (const s of stmts) out.push(await (/^\s*(select|with|pragma)/i.test(s.sql) ? s.all() : s.run()));
				sqlite.exec('COMMIT');
				return out;
			} catch (e) {
				sqlite.exec('ROLLBACK');
				throw e;
			}
		},
		async exec(sql: string) {
			sqlite.exec(sql);
			return { count: 1, duration: 0 };
		},
	};
	return db as unknown as TestD1;
}
