import { and, eq, notExists, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { invites, memberships, users, type MembershipRole } from '../schema';

export interface TeamMember {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'member';
	last_login_at: number | null;
	created_at: number;
}

export function teamQueries(db: Db, accountId: string) {
	return {
		/** Users who are members of this account (no credentials). */
		list(): Promise<TeamMember[]> {
			return db
				.select({ id: users.id, email: users.email, name: users.name, role: users.role, last_login_at: users.last_login_at, created_at: users.created_at })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.account_id, accountId)))
				.orderBy(users.created_at)
				.all();
		},

		/** A member of this account by id (no credentials), or null. */
		getMember(userId: string) {
			return db
				.select({ id: users.id, email: users.email, name: users.name, role: users.role })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.account_id, accountId)))
				.where(eq(users.id, userId))
				.get()
				.then((r) => r ?? null);
		},

		/** First admin of the account — the person digests and notices are sent to. */
		firstAdmin() {
			return db
				.select({ id: users.id, email: users.email, name: users.name })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.account_id, accountId)))
				.where(eq(users.role, 'admin'))
				.limit(1)
				.get()
				.then((r) => r ?? null);
		},

		/** Create a user and make them a member of this account, atomically. */
		async addUser(u: { id: string; email: string; name: string; password_hash: string | null; role: 'admin' | 'member' }) {
			// The first admin of an account becomes its owner.
			let role: MembershipRole = 'member';
			if (u.role === 'admin') {
				const owner = await db.select({ x: memberships.user_id }).from(memberships).where(and(eq(memberships.account_id, accountId), eq(memberships.role, 'owner'))).limit(1).get();
				role = owner ? 'admin' : 'owner';
			}
			await db.batch([db.insert(users).values(u), db.insert(memberships).values({ account_id: accountId, user_id: u.id, role })]);
		},

		/** Remove a member; the user row goes too once they belong to no account. */
		async removeUser(userId: string) {
			await db.delete(memberships).where(and(eq(memberships.account_id, accountId), eq(memberships.user_id, userId)));
			await db.delete(users).where(and(eq(users.id, userId), notExists(db.select({ x: sql`1` }).from(memberships).where(eq(memberships.user_id, users.id)))));
		},

		// ── Invites ───────────────────────────────────────────────
		getInvite(token: string) {
			return db.select().from(invites).where(and(eq(invites.account_id, accountId), eq(invites.token, token))).get().then((r) => r ?? null);
		},

		insertInvite(inv: { token: string; email: string; role: string; invited_by: string; expires_at: number }) {
			return db.insert(invites).values({ ...inv, account_id: accountId }).run();
		},

		markInviteUsed(token: string) {
			return db.update(invites).set({ used_at: sql`unixepoch()` as any }).where(and(eq(invites.account_id, accountId), eq(invites.token, token))).run();
		},
	};
}
