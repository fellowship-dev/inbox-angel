// A D1 binding that counts queries the way Cloudflare does, so tests can prove a per-invocation query budget.
// Local D1 (node:sqlite here, miniflare in `wrangler dev`) does not enforce the real limit; this wrapper does.
//
// Counted (https://developers.cloudflare.com/d1/platform/limits/ : "Queries per Worker invocation: 1000 (Workers Paid) /
// 50 (Free)"; "a db.batch() call counts as a single query against it, not one query per statement"):
//   prepare().first / all / run / raw   1 each
//   batch([...])                        1, whatever the number of statements in it
//   exec()                              1
// Past `limit` every call throws, as D1 does, and the call is still counted (so the total is what the code tried to run).

export interface CountingD1 {
  /** The binding to put in env.DB. */
  db: D1Database;
  /** Queries attempted since the last reset (including the ones refused past the limit). */
  readonly count: number;
  /** Queries refused because the limit was already used up. */
  readonly refused: number;
  /** Statements inside batch() calls (not counted against the limit, reported for the record). */
  readonly batchedStatements: number;
  /** Largest number of statements in one batch(). */
  readonly largestBatch: number;
  /** First word of each counted query, tallied: { select: 1200, insert: 4, batch: 3 }. */
  readonly kinds: Record<string, number>;
  /** The first 70 characters of every counted query, in order (to see which one a budget ran out on). */
  readonly trace: string[];
  reset(limit?: number): void;
}

const kindOf = (sql: string) => (sql.trim().split(/\s+/)[0] ?? '').toLowerCase();

export function countingD1(inner: D1Database, limit = 1000): CountingD1 {
  let count = 0;
  let refused = 0;
  let batched = 0;
  let largest = 0;
  let max = limit;
  let kinds: Record<string, number> = {};
  let trace: string[] = [];

  const spend = (kind: string, sql = kind) => {
    count++;
    trace.push(sql.replace(/\s+/g, " ").slice(0, 70));
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (count > max) {
      refused++;
      throw new Error(`D1_ERROR: Exceeded the maximum number of queries per Worker invocation (${max})`);
    }
  };

  const wrap = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === '__inner') return target;
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => {
            spend(kindOf(sql), sql);
            return target[prop](...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

  const db = new Proxy(inner as any, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch') {
        return (stmts: any[]) => {
          spend('batch');
          batched += stmts.length;
          largest = Math.max(largest, stmts.length);
          return target.batch(stmts.map((s) => s.__inner ?? s));
        };
      }
      if (prop === 'exec') return (sql: string) => { spend('exec'); return target.exec(sql); };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;

  return {
    db,
    get count() { return count; },
    get refused() { return refused; },
    get batchedStatements() { return batched; },
    get largestBatch() { return largest; },
    get kinds() { return { ...kinds }; },
    get trace() { return [...trace]; },
    reset(l = limit) { count = 0; refused = 0; batched = 0; largest = 0; kinds = {}; trace = []; max = l; },
  };
}
