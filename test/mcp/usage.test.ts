import { it, expect } from 'vitest';
import { forWorkspace } from '@inbox-angel/db';
import { connection } from './helpers';
import { recordAgentUse, resolveMcpIdentity } from '../../src/auth/mcp-issuer';
import { listAgentConnections } from '../../src/mcp/connections';
import type { TestDb } from '../auth/helpers';

it('keeps own connection controls discoverable after its original membership is removed', async () => {
 const {env,user,q}=await connection();
 const scope=forWorkspace(env.DB,'ws_default');
 await scope.settings.set('mcp_connection:agent',JSON.stringify({principalId:'agent',userId:user.id,workspaceId:'ws_default',name:'Portfolio'}));
 await q.principals.create({id:'service',name:'Service',kind:'service',user_id:user.id});
 await scope.settings.set('mcp_connection:service',JSON.stringify({principalId:'service'}));
 (env.DB as unknown as TestDb).sqlite.prepare('DELETE FROM memberships WHERE user_id = ?').run(user.id);
 expect((await listAgentConnections(env,user.id)).map(c=>c.principalId)).toEqual(['agent']);
 expect(await listAgentConnections(env,'another-user')).toEqual([]);
 await q.principals.disable('agent',1);
 expect((await listAgentConnections(env,user.id))[0].revoked).toBe(true);
});

it('records last use for an existing human connection without changing its authority',async()=>{
 const {env,props}=await connection(),scope=forWorkspace(env.DB,'ws_default');
 const subject=(await resolveMcpIdentity(env,props))!;
 const before={principalId:subject.principalId,userId:subject.userId,expiresAt:1793000000};
 await scope.settings.set('mcp_connection:'+subject.principalId,JSON.stringify(before));
 await recordAgentUse(env,subject,1792954800);
 const stored=JSON.parse((await scope.settings.get('mcp_connection:'+subject.principalId))!.value);
 expect(stored).toEqual({...before,lastUsedAt:1792954800});
 expect((await resolveMcpIdentity(env,props))!.grants).toEqual(subject.grants);
 await recordAgentUse(env,{...subject,principalId:'not-a-connection'},1792954800);
 expect(await scope.settings.get('mcp_connection:not-a-connection')).toBeNull();
});
