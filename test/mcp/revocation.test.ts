import { it, expect } from 'vitest';
import { connection } from './helpers';
import { resolveMcpIdentity } from '../../src/auth/mcp-issuer';
import { revokeAgentConnection } from '../../src/mcp/connections';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { TestDb } from '../auth/helpers';
it('D1 denial survives provider storage cleanup failure', async () => {
 const { env, props, user } = await connection();
 const api = { listUserGrants: async () => { throw new Error('KV unavailable'); } } as unknown as OAuthHelpers;
 await expect(revokeAgentConnection(env, user.id, 'agent', api)).rejects.toThrow('KV unavailable');
 expect(await resolveMcpIdentity(env, props)).toBeNull();
});
it('fresh grant expiry and removed membership stop authorization', async () => {
 const { env, props, q, user } = await connection();
 await q.grants.revoke('grant', Math.floor(Date.now()/1000));
 expect(await resolveMcpIdentity(env, props)).toBeNull();
 const expired = await connection();
 (expired.env.DB as unknown as TestDb).sqlite.prepare('UPDATE access_grants SET expires_at = 1 WHERE id = ?').run('grant');
 expect(await resolveMcpIdentity(expired.env, expired.props)).toBeNull();
 const other = await connection();
 (other.env.DB as unknown as TestDb).sqlite.prepare('DELETE FROM memberships WHERE user_id = ?').run(other.user.id);
 expect(await resolveMcpIdentity(other.env, other.props)).toBeNull();
});
