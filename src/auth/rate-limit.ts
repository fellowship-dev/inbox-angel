// Better Auth rate-limit storage on D1. Workers isolates share no memory, so the default
// in-memory limiter would not limit anything. A single atomic upsert (globalQueries.rateLimit.hit)
// both counts the request and tells us the count, so concurrent requests cannot all slip under the limit.
//
// Expired rows are swept opportunistically (hosted instances run no crons): about one write in 16 deletes up to 200 rows
// whose last window ended more than two days ago (the longest window kept here is one day). Spraying random keys, such as
// random addresses at sign-in, therefore cannot grow the table without bound.
import { globalQueries } from '@ready-set-mail/db';

/** Older than the longest window (one day), with a day of margin. */
export const RATE_LIMIT_ROW_TTL_MS = 2 * 86_400_000;
export const SWEEP_BATCH = 200;
const SWEEP_CHANCE = 1 / 16;

/** Delete at most SWEEP_BATCH expired rows. Returns how many went. */
export async function sweepExpiredRateLimits(db: D1Database, now = Date.now()): Promise<number> {
  const r = await db.prepare('DELETE FROM auth_rate_limits WHERE id IN (SELECT id FROM auth_rate_limits WHERE last_request < ?1 LIMIT ?2)').bind(now - RATE_LIMIT_ROW_TTL_MS, SWEEP_BATCH).run();
  return r.meta.changes ?? 0;
}

export function d1RateLimitStorage(db: D1Database, random: () => number = Math.random) {
  return {
    async consume(key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }> {
      const now = Date.now();
      const windowMs = rule.window * 1000;
      const row = await globalQueries(db).rateLimit.hit(key, now, windowMs);
      if (random() < SWEEP_CHANCE) await sweepExpiredRateLimits(db, now).catch(() => 0);
      if (!row || row.count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.lastRequest + windowMs - now) / 1000)) };
    },
  };
}
