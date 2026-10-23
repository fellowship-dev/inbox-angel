// Revoking Cloudflare access when the workspace that holds it goes away.
//
// Deleting a workspace used to drop its connection rows without telling Cloudflare, leaving OAuth grants live.
// Now every connection is disconnected first (which revokes OAuth grants remotely). When Cloudflare cannot be
// reached the purge still goes ahead, but a tombstone keeps the sealed token so the daily cron can retry.

import { lifecycleQueries } from '@inbox-angel/db';
import { TokenCrypto } from '../connections/crypto';
import { revokeSealedGrant } from '../connections/service';
import type { TenantContext } from '../tenancy/context';

/** A tombstone is dropped after this many failed retries or this many days, whichever comes first. */
export const MAX_REVOKE_ATTEMPTS = 10;
export const MAX_TOMBSTONE_AGE_DAYS = 30;

export interface RevokeSummary { connections: number; revoked: number; failed: number; pasted_tokens: number }

/**
 * Disconnect every Cloudflare connection of the workspace. Never throws: a failure is logged and tombstoned.
 * Pasted API tokens cannot be revoked remotely; they are counted so the caller can tell the owner.
 */
export async function revokeWorkspaceConnections(tenant: TenantContext): Promise<RevokeSummary> {
  const q = tenant.scope.connections;
  const life = lifecycleQueries(tenant.db);
  const summary: RevokeSummary = { connections: 0, revoked: 0, failed: 0, pasted_tokens: 0 };
  let list;
  try {
    list = await q.list();
  } catch (e) {
    console.error(`[lifecycle] workspace ${tenant.workspaceId}: could not list connections to revoke:`, e instanceof Error ? e.message : e);
    return summary;
  }
  for (const c of list) {
    summary.connections++;
    if (c.auth_type !== 'oauth') summary.pasted_tokens++;
    try {
      // A grant Cloudflare did not confirm revoked is tombstoned (sealed) for the cron to retry, before the row goes.
      const result = await tenant.connections.disconnectKeepingFailedGrant(c.id, async (sealed, row) => {
        console.error(`[lifecycle] workspace ${tenant.workspaceId}: Cloudflare did not confirm the revocation of connection ${c.id}; will retry from the cron`);
        await life.tombstones.add({ id: crypto.randomUUID(), deleted_workspace_id: tenant.workspaceId, connection_id: c.id, cf_account_id: row.cf_account_id, sealed_grant: sealed, last_error: 'revoke not confirmed' });
      });
      if (c.auth_type === 'oauth') {
        if (result?.revokedRemote) summary.revoked++;
        else summary.failed++;
      }
    } catch (e) {
      summary.failed++;
      console.error(`[lifecycle] workspace ${tenant.workspaceId}: disconnecting ${c.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return summary;
}

/** Cron: retry the tombstoned revocations. Returns how many were revoked and how many were dropped. */
export async function retryRevocations(
  env: Parameters<typeof TokenCrypto.fromEnv>[0] & Parameters<typeof revokeSealedGrant>[0] & { DB: D1Database },
  opts: { now?: () => number; fetch?: typeof fetch } = {},
): Promise<{ retried: number; revoked: number; dropped: number }> {
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const life = lifecycleQueries(env.DB);
  const out = { retried: 0, revoked: 0, dropped: 0 };
  const rows = await life.tombstones.list();
  if (rows.length === 0) return out;
  let crypt: TokenCrypto | null = null;
  try { crypt = TokenCrypto.fromEnv(env); } catch { /* no key: nothing can be opened, the rows age out */ }
  for (const t of rows) {
    const expired = t.attempts >= MAX_REVOKE_ATTEMPTS || t.created_at < now - MAX_TOMBSTONE_AGE_DAYS * 86400;
    if (expired) {
      await life.tombstones.delete(t.id);
      out.dropped++;
      console.error(`[lifecycle] giving up revoking connection ${t.connection_id} of deleted workspace ${t.deleted_workspace_id} after ${t.attempts} attempts`);
      continue;
    }
    out.retried++;
    const ok = crypt ? await revokeSealedGrant(env, crypt, t.deleted_workspace_id, t.connection_id, t.sealed_grant, opts.fetch) : false;
    if (ok) {
      await life.tombstones.delete(t.id);
      out.revoked++;
    } else {
      await life.tombstones.failed(t.id, crypt ? 'revoke not confirmed' : 'no encryption key');
    }
  }
  console.log(`[lifecycle] revocation retries ${JSON.stringify(out)}`);
  return out;
}
