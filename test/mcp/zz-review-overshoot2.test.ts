import { it } from 'vitest';
import { globalQueries } from '@inbox-angel/db';
import { spendDnsCheck } from '../../src/mcp/rate-limit';
import { connection } from './helpers';
it('review: parallel overshoot v2', async () => {
 const W = 60_000;
 for (let round = 0; round < 3; round++) {
  const { env } = await connection();
  const now = Date.now();
  const a = await Promise.allSettled(Array.from({ length: 100 }, () => spendDnsCheck(env, 'one', 'ws_default', { prune: false, now })));
  const q = globalQueries(env.DB).rateLimit;
  const wsA = await q.peek('mcp-dns:workspace:ws_default', now, W), cA = await q.peek('mcp-dns:connection:one', now, W);
  console.log(`REVIEW r${round} oneConn100: passed=${a.filter(r => r.status === 'fulfilled').length} wsCount=${wsA?.count} connCount=${cA?.count}`);
  const { env: e2 } = await connection();
  const b = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => spendDnsCheck(e2, 'c' + (i % 10), 'ws_default', { prune: false, now }).then(() => 'c' + (i % 10))));
  const per: Record<string, number> = {}; for (const r of b) if (r.status === 'fulfilled') per[r.value] = (per[r.value] ?? 0) + 1;
  const q2 = globalQueries(e2.DB).rateLimit; const ws = await q2.peek('mcp-dns:workspace:ws_default', now, W);
  const conns = await Promise.all(Array.from({ length: 10 }, (_, i) => q2.peek('mcp-dns:connection:c' + i, now, W)));
  console.log(`REVIEW r${round} tenConn100: passed=${b.filter(r => r.status === 'fulfilled').length} maxPerConn=${Math.max(...Object.values(per))} wsCount=${ws?.count} connCounts=${conns.map(c => c?.count ?? 0).join(',')}`);
  // window boundary: fill, then fire 100 at now+W (new window) mixed with stale-now callers
  const { env: e3 } = await connection();
  for (let i = 0; i < 10; i++) await spendDnsCheck(e3, 'x', 'ws_default', { prune: false, now });
  const mix = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => spendDnsCheck(e3, 'x', 'ws_default', { prune: false, now: i % 2 ? now + W : now + W - 1 })));
  const q3 = globalQueries(e3.DB).rateLimit;
  console.log(`REVIEW r${round} boundary: passed=${mix.filter(r => r.status === 'fulfilled').length} conn=${(await q3.peek('mcp-dns:connection:x', now + W, W))?.count} ws=${(await q3.peek('mcp-dns:workspace:ws_default', now + W, W))?.count}`);
 }
});
