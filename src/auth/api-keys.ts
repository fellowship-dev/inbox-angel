// Per-user API keys. The secret is shown once; only its SHA-256 is stored.
// A key acts as its owner in the workspace it was created for, with the owner's *current*
// role there, so demoting or removing a member also limits or ends their keys.
import { authLookups, forWorkspace, type MembershipRole } from '@inbox-angel/db';

export const API_KEY_PREFIX = 'ia_';
/** Characters of the key kept for display: `ia_` + 5 characters of the secret. */
const DISPLAY_PREFIX_LEN = API_KEY_PREFIX.length + 5;

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return API_KEY_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CreatedApiKey {
  id: string;
  /** The full key. Returned once; not recoverable afterwards. */
  key: string;
  prefix: string;
}

export async function createApiKey(
  db: D1Database,
  p: { workspaceId: string; userId: string; name: string; expiresInDays?: number | null },
): Promise<CreatedApiKey> {
  const key = newSecret();
  const id = crypto.randomUUID();
  const prefix = key.slice(0, DISPLAY_PREFIX_LEN);
  const expires_at = p.expiresInDays ? Math.floor(Date.now() / 1000) + Math.floor(p.expiresInDays * 86400) : null;
  await forWorkspace(db, p.workspaceId).apiKeys.insert({ id, user_id: p.userId, name: p.name, prefix, key_hash: await hashApiKey(key), expires_at });
  return { id, key, prefix };
}

export interface ResolvedApiKey {
  keyId: string;
  userId: string;
  workspaceId: string;
  role: MembershipRole;
}

/** The key's owner, workspace and current role, or null if the key is unknown, revoked, expired, or its owner left the workspace. */
export async function resolveApiKey(db: D1Database, key: string): Promise<ResolvedApiKey | null> {
  const lookups = authLookups(db);
  const row = await lookups.apiKeyByHash(await hashApiKey(key));
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.revoked_at || (row.expires_at !== null && row.expires_at <= now)) return null;
  const role = await forWorkspace(db, row.workspace_id).team.roleOf(row.user_id);
  if (!role) return null;
  await lookups.touchApiKey(row.id, now);
  return { keyId: row.id, userId: row.user_id, workspaceId: row.workspace_id, role };
}
