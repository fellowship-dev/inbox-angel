/**
 * The few lookups that run *before* the workspace is known: they turn a credential
 * (a user, an API key) into the workspace(s) it may act in. Every other query takes an
 * workspace id from the result. Each is a deliberate workspace-scope exemption (pinned by
 * test/db/workspace-predicates.test.ts) and returns only what resolving needs.
 */
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { apiKeys, invites, memberships, workspaces } from '../schema';

export function authLookups(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** Every workspace a user belongs to, oldest membership first. */
		membershipsOf: (userId: string) =>
			db
				.select({ workspace_id: memberships.workspace_id, role: memberships.role })
				.from(memberships)
				.where(/* workspace-scope-exempt: resolving a user's workspaces is the point of this lookup */ eq(memberships.user_id, userId))
				.orderBy(memberships.created_at, sql`${memberships}.rowid`)
				.all(),

		/** An API key by the SHA-256 of its secret. */
		apiKeyByHash: (keyHash: string) =>
			db
				.select()
				.from(apiKeys)
				.where(/* workspace-scope-exempt: the key hash identifies the workspace */ eq(apiKeys.key_hash, keyHash))
				.get()
				.then((r) => r ?? null),

		/** An invite by its (unguessable) token, whichever workspace issued it. */
		inviteByToken: (token: string) =>
			db
				.select()
				.from(invites)
				.where(/* workspace-scope-exempt: the invite token identifies the workspace */ eq(invites.token, token))
				.get()
				.then((r) => r ?? null),

		/** The oldest unused, unexpired invite addressed to an email, in any workspace. */
		pendingInviteForEmail: (email: string, nowSeconds: number) =>
			db
				.select()
				.from(invites)
				.where(/* workspace-scope-exempt: deciding which workspace an OAuth sign-up may join */ and(eq(invites.email, email), isNull(invites.used_at), gt(invites.expires_at, nowSeconds)))
				.orderBy(asc(invites.created_at))
				.limit(1)
				.get()
				.then((r) => r ?? null),

		/** Every unused, unexpired invite addressed to an email, with its workspace's name: what a signed-in, verified person with no workspace yet is offered. */
		pendingInvitesForEmail: (email: string, nowSeconds: number) =>
			db
				.select({ token: invites.token, role: invites.role, invited_by: invites.invited_by, workspace_id: invites.workspace_id, workspace_name: workspaces.name })
				.from(invites)
				.innerJoin(workspaces, eq(workspaces.id, invites.workspace_id))
				.where(/* workspace-scope-exempt: the invites addressed to the caller's own verified email, across workspaces */ and(eq(invites.email, email), isNull(invites.used_at), gt(invites.expires_at, nowSeconds)))
				.orderBy(asc(invites.created_at))
				.all(),

		/** Record use, at most once per `minGapSeconds` so authenticated reads do not each cost a write. */
		touchApiKey: (id: string, nowSeconds: number, minGapSeconds = 60) =>
			db
				.update(apiKeys)
				.set(/* workspace-scope-exempt: addressed by the primary key of a key that was just resolved */ { last_used_at: nowSeconds })
				.where(and(eq(apiKeys.id, id), sql`(${apiKeys.last_used_at} IS NULL OR ${apiKeys.last_used_at} < ${nowSeconds - minGapSeconds})`))
				.run(),
	};
}
