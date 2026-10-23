import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { apiKeys } from '../schema';

export interface ApiKeyInfo {
	id: string;
	user_id: string;
	name: string;
	/** First characters of the key — safe to display, not enough to use. */
	prefix: string;
	created_at: number;
	last_used_at: number | null;
	expires_at: number | null;
	revoked_at: number | null;
}

const cols = {
	id: apiKeys.id,
	user_id: apiKeys.user_id,
	name: apiKeys.name,
	prefix: apiKeys.prefix,
	created_at: apiKeys.created_at,
	last_used_at: apiKeys.last_used_at,
	expires_at: apiKeys.expires_at,
	revoked_at: apiKeys.revoked_at,
};

/** Per-user API keys of one workspace. The key itself is never stored, only its hash. */
export function apiKeyQueries(db: Db, workspaceId: string) {
	return {
		insert(k: { id: string; user_id: string; name: string; prefix: string; key_hash: string; expires_at?: number | null }) {
			return db.insert(apiKeys).values({ ...k, expires_at: k.expires_at ?? null, workspace_id: workspaceId }).run();
		},

		/** Active (unrevoked) keys in this workspace, newest first; optionally only one user's. */
		list(userId?: string): Promise<ApiKeyInfo[]> {
			return db
				.select(cols)
				.from(apiKeys)
				.where(and(eq(apiKeys.workspace_id, workspaceId), isNull(apiKeys.revoked_at), userId ? eq(apiKeys.user_id, userId) : undefined))
				.orderBy(desc(apiKeys.created_at), desc(apiKeys.id))
				.all();
		},

		get(id: string): Promise<ApiKeyInfo | null> {
			return db
				.select(cols)
				.from(apiKeys)
				.where(and(eq(apiKeys.workspace_id, workspaceId), eq(apiKeys.id, id)))
				.get()
				.then((r) => r ?? null);
		},

		/** Revoke every active key of one user in this workspace; returns how many. */
		async revokeAllForUser(userId: string, now: number): Promise<number> {
			const res = await db
				.update(apiKeys)
				.set({ revoked_at: now })
				.where(and(eq(apiKeys.workspace_id, workspaceId), eq(apiKeys.user_id, userId), isNull(apiKeys.revoked_at)))
				.returning({ id: apiKeys.id });
			return res.length;
		},

		/** Revoke; returns whether an active key was revoked. */
		async revoke(id: string, now: number): Promise<boolean> {
			const res = await db
				.update(apiKeys)
				.set({ revoked_at: now })
				.where(and(eq(apiKeys.workspace_id, workspaceId), eq(apiKeys.id, id), isNull(apiKeys.revoked_at)))
				.returning({ id: apiKeys.id });
			return res.length > 0;
		},
	};
}
