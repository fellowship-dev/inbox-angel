// Audit log — fire-and-forget helper for recording all mutations.
//
// Every state-changing operation in the Worker (DNS, auth, domain, team, cron)
// calls logAudit(). The write is non-blocking: if ctx is provided it uses
// ctx.waitUntil so it never adds latency to the response. If DB is unavailable
// the error is logged but never thrown.
//
// before_value / after_value are serialised to JSON strings at insert time.
// Reads parse them back. Callers pass raw objects — no pre-serialisation needed.

import { scope } from '../db/scope';

/** What an audit entry is written for: a TenantContext satisfies this. */
export interface AuditTarget { db: D1Database; accountId: string }

export interface AuditEntry {
  actor_id?: string | null;
  actor_email?: string | null;
  actor_type?: 'user' | 'system';
  action: string;
  resource_type?: string | null;
  resource_id?: string | null;
  resource_name?: string | null;
  before_value?: unknown;
  after_value?: unknown;
  meta?: Record<string, unknown> | null;
}

export function logAudit(
  target: AuditTarget,
  entry: AuditEntry,
  ctx?: ExecutionContext,
): void {
  const run = Promise.resolve()
    .then(() =>
      scope(target.db, target.accountId).audit.insert({
        actor_id: entry.actor_id,
        actor_email: entry.actor_email,
        actor_type: entry.actor_type,
        action: entry.action,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id,
        resource_name: entry.resource_name,
        before_value: entry.before_value != null ? JSON.stringify(entry.before_value) : null,
        after_value: entry.after_value != null ? JSON.stringify(entry.after_value) : null,
        meta: entry.meta ? JSON.stringify(entry.meta) : null,
      }),
    )
    .catch((e: unknown) => console.error('[audit] log failed:', e));

  if (ctx) {
    ctx.waitUntil(run);
  }
}
