export interface Shard { index: number; total: number }

/** Parse "i/n" (1-based, 1 <= i <= n). */
export function parseShard(spec: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`invalid --shard "${spec}" (expected i/n, e.g. 2/4)`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) throw new Error(`invalid --shard "${spec}": need 1 <= i <= n`);
  return { index, total };
}

/**
 * Take shard `i` of `n` using round-robin by position, so shards are disjoint,
 * their union is the input, and sizes differ by at most one. Order-stable.
 */
export function takeShard<T>(items: T[], shard: Shard): T[] {
  return items.filter((_, pos) => pos % shard.total === shard.index - 1);
}
