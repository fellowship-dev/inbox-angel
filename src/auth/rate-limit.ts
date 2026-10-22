// Better Auth rate-limit storage on D1. Workers isolates share no memory, so the default
// in-memory limiter would not limit anything. A single atomic upsert (globalQueries.rateLimit.hit)
// both counts the request and tells us the count, so concurrent requests cannot all slip under the limit.
import { globalQueries } from '@inbox-angel/db';

export function d1RateLimitStorage(db: D1Database) {
  return {
    async consume(key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }> {
      const now = Date.now();
      const windowMs = rule.window * 1000;
      const row = await globalQueries(db).rateLimit.hit(key, now, windowMs);
      if (!row || row.count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.lastRequest + windowMs - now) / 1000)) };
    },
  };
}
