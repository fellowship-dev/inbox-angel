/**
 * The tables Better Auth's Drizzle adapter reads and writes, keyed by Better Auth's
 * model names. Everything except `user` is the table from schema.ts; `user` is a
 * second Drizzle view of the same physical `users` table with the field names and
 * `timestamp`/`boolean` modes the adapter needs (schema.ts keeps `users` plain so
 * the rest of the app still sees unix-second numbers).
 *
 * `test/auth-schema.test.ts` checks the view against the migrated database.
 */
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { authAccounts, authRateLimits, sessions, verifications } from './schema';

const now = sql`(unixepoch())`;

export const authUser = sqliteTable('users', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
});

export const betterAuthSchema = {
	user: authUser,
	session: sessions,
	account: authAccounts,
	verification: verifications,
	rateLimit: authRateLimits,
};
