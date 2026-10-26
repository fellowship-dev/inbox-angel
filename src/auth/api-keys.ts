// Machine credentials deliberately replace prelaunch broad ia_ keys. Only hashes persist.
import { accessLookups, forWorkspace, type MembershipRole } from '@inbox-angel/db';
import { resolveAccessSubject } from '../access/resolve';
import type { AccessSubject } from '../access/principal';
export const API_KEY_PREFIX = 'ias_';
export function looksLikeApiKey(value: string): boolean { return value.startsWith(API_KEY_PREFIX) || value.startsWith('ia_'); }
export async function hashApiKey(key: string): Promise<string> {
 const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
 return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
export interface CreatedApiKey { id: string; key: string; prefix: string }
export async function issueAccessCredential(db: D1Database, p: { workspaceId: string; principalId: string; name: string; expiresAt: number }): Promise<CreatedApiKey> {
 if (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('credential expiry must be a future timestamp');
 const principal = await forWorkspace(db, p.workspaceId).access.principals.get(p.principalId);
 if (!principal || principal.disabled_at !== null) throw new Error('principal not available');
 const bytes = crypto.getRandomValues(new Uint8Array(32));
 const key = API_KEY_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 const id = crypto.randomUUID(), prefix = key.slice(0, API_KEY_PREFIX.length + 5);
 await forWorkspace(db, p.workspaceId).access.credentials.create({ id, workspace_id: p.workspaceId, principal_id: p.principalId, name: p.name, prefix, key_hash: await hashApiKey(key), expires_at: p.expiresAt });
 return { id, key, prefix };
}
export interface ResolvedApiKey {
 keyId: string; userId: string | null; workspaceId: string; role: MembershipRole; access: AccessSubject;
}
export async function resolveApiKey(db: D1Database, key: string): Promise<ResolvedApiKey | null> {
 if (!key.startsWith(API_KEY_PREFIX)) return null;
 const row = await accessLookups(db).credentialByHash(await hashApiKey(key));
 const now = Math.floor(Date.now() / 1000);
 if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
 const access = await resolveAccessSubject(db, row.principal_id);
 if (!access || access.workspaceId !== row.workspace_id) return null;
 const role = access.kind === 'service' ? 'admin' : access.memberships?.find(m => m.workspaceId === row.workspace_id)?.role;
 if (!role) return null;
 await forWorkspace(db, row.workspace_id).access.credentials.touch(row.id, now);
 return { keyId: row.id, userId: access.userId ?? null, workspaceId: row.workspace_id, role, access: { ...access, credentialId: row.id } };
}
