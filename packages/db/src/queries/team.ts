import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { invites, memberships, users, type MembershipRole } from '../schema';

export interface TeamMember {
	id: string;
	email: string;
	name: string;
	role: MembershipRole;
	last_login_at: number | null;
	created_at: number;
}

export function teamQueries(db: Db, workspaceId: string) {
	return {
		/** Users who are members of this workspace (no credentials). */
		list(): Promise<TeamMember[]> {
			return db
				.select({ id: users.id, email: users.email, name: users.name, role: memberships.role, last_login_at: users.last_login_at, created_at: users.created_at })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.workspace_id, workspaceId)))
				.orderBy(users.created_at)
				.all();
		},

		/** A member of this workspace by id (no credentials), or null. */
		getMember(userId: string) {
			return db
				.select({ id: users.id, email: users.email, name: users.name, role: memberships.role })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.workspace_id, workspaceId)))
				.where(eq(users.id, userId))
				.get()
				.then((r) => r ?? null);
		},

		/** The workspace's owner (else its earliest admin) — the person digests and notices are sent to. */
		firstAdmin() {
			return db
				.select({ id: users.id, email: users.email, name: users.name })
				.from(users)
				.innerJoin(memberships, and(eq(memberships.user_id, users.id), eq(memberships.workspace_id, workspaceId)))
				.where(inArray(memberships.role, ['owner', 'admin']))
				.orderBy(sql`CASE ${memberships.role} WHEN 'owner' THEN 0 ELSE 1 END`, memberships.created_at, users.created_at)
				.limit(1)
				.get()
				.then((r) => r ?? null);
		},

		/** Does this workspace have an owner yet? (False means first-run setup is open.) */
		hasOwner(): Promise<boolean> {
			return db
				.select({ x: memberships.user_id })
				.from(memberships)
				.where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.role, 'owner')))
				.limit(1)
				.get()
				.then((r) => !!r);
		},

		/** The user's role in this workspace, or null if they are not a member. */
		roleOf(userId: string): Promise<MembershipRole | null> {
			return db
				.select({ role: memberships.role })
				.from(memberships)
				.where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId)))
				.get()
				.then((r) => r?.role ?? null);
		},

		/**
		 * Make an existing user the workspace's owner iff it has none yet — one statement, so
		 * two concurrent first sign-ups cannot both win. Returns whether this call did.
		 */
		async claimOwnership(userId: string): Promise<boolean> {
			const res = await db.run(sql`INSERT INTO memberships (workspace_id, user_id, role)
				SELECT ${workspaceId}, ${userId}, 'owner'
				WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = ${workspaceId} AND role = 'owner')`);
			return ((res as any).meta?.changes ?? (res as any).changes ?? 0) > 0;
		},

		/** Add an existing user to this workspace (no-op if they already belong). */
		addMember(userId: string, role: MembershipRole) {
			return db.insert(memberships).values({ workspace_id: workspaceId, user_id: userId, role }).onConflictDoNothing().run();
		},

		/** Create a user and make them a member of this workspace, atomically. */
		async addUser(u: { id: string; email: string; name: string; password_hash: string | null; role: 'admin' | 'member' }) {
			// The first admin of a workspace becomes its owner.
			let role: MembershipRole = 'member';
			if (u.role === 'admin') {
				const owner = await db.select({ x: memberships.user_id }).from(memberships).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.role, 'owner'))).limit(1).get();
				role = owner ? 'admin' : 'owner';
			}
			await db.batch([db.insert(users).values(u), db.insert(memberships).values({ workspace_id: workspaceId, user_id: u.id, role })]);
		},

		/** Remove a member; the user row goes too once they belong to no workspace. */
		async removeUser(userId: string) {
			await db.delete(memberships).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId)));
			await db.delete(users).where(
				and(
					eq(users.id, userId),
					notExists(
						db.select({ x: sql`1` }).from(memberships /* workspace-scope-exempt: "belongs to no workspace at all" is deliberately cross-workspace */).where(eq(memberships.user_id, users.id)),
					),
				),
			);
		},

		/** Remove only the membership (the user keeps their login and other workspaces). */
		removeMembership(userId: string) {
			return db.delete(memberships).where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId))).run();
		},

		// ── Invites ───────────────────────────────────────────────
		getInvite(token: string) {
			return db.select().from(invites).where(and(eq(invites.workspace_id, workspaceId), eq(invites.token, token))).get().then((r) => r ?? null);
		},

		insertInvite(inv: { token: string; email: string; role: string; invited_by: string; expires_at: number }) {
			return db.insert(invites).values({ ...inv, workspace_id: workspaceId }).run();
		},

		markInviteUsed(token: string) {
			return db.update(invites).set({ used_at: sql`unixepoch()` as any }).where(and(eq(invites.workspace_id, workspaceId), eq(invites.token, token))).run();
		},
	};
}
