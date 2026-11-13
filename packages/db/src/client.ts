import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

/** A raw D1 binding, or an already-wrapped Drizzle handle. */
export type DbLike = D1Database | Db;

export function getDb(db: DbLike): Db {
	// A D1Database has `prepare`; a Drizzle handle has `select`.
	return 'select' in db ? (db as Db) : drizzle(db as D1Database, { schema });
}

/**
 * Drizzle wraps driver failures in a "Failed query: …" error and moves the
 * original (e.g. "UNIQUE constraint failed: domains.domain") to `cause`. Callers
 * match on the driver's message, so surface that instead.
 */
export function unwrapDriverError(e: unknown): unknown {
	const cause = (e as { cause?: unknown } | null)?.cause;
	return cause instanceof Error ? cause : e;
}

/**
 * Drizzle's batch only takes its own builders, which cannot express `INSERT … SELECT … WHERE <count> < <max>` for a table with many
 * defaulted columns. These run such statements (and Drizzle builders next to them) through the D1 binding's own batch: still one
 * transaction, all or nothing, with the same `{ meta: { changes, last_row_id } }` results.
 */
type Buildable = SQL | { toSQL(): { sql: string; params: unknown[] } };
const dialect = new SQLiteAsyncDialect();

export function prepareStatement(db: Db, q: Buildable): D1PreparedStatement {
	const { sql, params } = 'toSQL' in q ? q.toSQL() : dialect.sqlToQuery(q);
	return (db as unknown as { $client: D1Database }).$client.prepare(sql).bind(...params);
}

export function batchStatements(db: Db, stmts: Buildable[]): Promise<D1Result[]> {
	return (db as unknown as { $client: D1Database }).$client.batch(stmts.map((s) => prepareStatement(db, s)));
}
