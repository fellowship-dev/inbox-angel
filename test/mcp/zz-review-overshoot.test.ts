import { it } from 'vitest';
import { spendDnsCheck } from '../../src/mcp/rate-limit';
import { connection } from './helpers';
it('review: parallel overshoot', async () => {
 for (const n of [5, 20, 50, 100]) {
  const { env } = await connection();
  const res = await Promise.allSettled(Array.from({ length: n }, (_, i) => spendDnsCheck(env, 'agent', 'ws_default', { prune: false })));
  const okConn = res.filter(r => r.status === 'fulfilled').length;
  const { env: env2 } = await connection();
  const res2 = await Promise.allSettled(Array.from({ length: n }, (_, i) => spendDnsCheck(env2, 'agent-' + i, 'ws_default', { prune: false })));
  console.log(`REVIEW parallel=${n} oneConnection_passed=${okConn} (limit 10) manyConnections_samWorkspace_passed=${res2.filter(r => r.status === 'fulfilled').length} (limit 30)`);
 }
});
