import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

/** A raw D1 binding, or an already-wrapped Drizzle handle. */
export type DbLike = D1Database | Db;

export function getDb(db: DbLike): Db {
	// A D1Database has `prepare`; a Drizzle handle has `select`.
	return 'select' in db ? (db as Db) : drizzle(db as D1Database, { schema });
}
