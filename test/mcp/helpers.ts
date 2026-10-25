import { makeEnv, setupOwner, type TestDb } from '../auth/helpers';
import { forWorkspace } from '@inbox-angel/db';
import type { BoundEnv } from '../../src/index';
export async function connection() {
 const env = makeEnv(undefined, { BETTER_AUTH_URL: 'https://ia.example.com' }) as BoundEnv;
 await setupOwner(env);
 const user = (env.DB as unknown as TestDb).sqlite.prepare('SELECT id FROM users LIMIT 1').get() as { id: string };
 const q = forWorkspace(env.DB, 'ws_default').access;
 await q.principals.create({ id: 'agent', name: 'test', kind: 'human', user_id: user.id });
 await q.grants.create({ id: 'grant', principal_id: 'agent', workspace_id: 'ws_default', domain: 'example.com', actions: '["reports:read"]', expires_at: Math.floor(Date.now()/1000)+1000 });
 return { env, props: { principalId: 'agent', issuer: 'https://ia.example.com', resource: 'https://ia.example.com/mcp' }, q, user };
}
