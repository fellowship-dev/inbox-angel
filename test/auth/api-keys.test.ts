import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { forWorkspace } from '@inbox-angel/db';
import { issueAccessCredential, resolveApiKey } from '../../src/auth/api-keys';
import { authenticate } from '../../src/auth/session';
import { requireAuth } from '../../src/api/auth';
import type { AuthEnv } from '../../src/auth/config';

async function fixture() {
 const db=createMigratedD1(), q=forWorkspace(db,'ws_default');
 await q.access.principals.create({id:'svc',kind:'service',name:'Product A'});
 await q.domains.insert({domain:'a.example.com',rua_address:'r@example.com'});
 await q.domains.insert({domain:'b.example.com',rua_address:'r@example.com'});
 const domains=await q.domains.list();
 await q.access.grants.create({id:'grant',workspace_id:'ws_default',principal_id:'svc',domain:'a.example.com',actions:'["reports:read"]',expires_at:Math.floor(Date.now()/1000)+3600});
 const credential=await issueAccessCredential(db,{workspaceId:'ws_default',principalId:'svc',name:'CI',expiresAt:Math.floor(Date.now()/1000)+3600});
 return {db,q,domains,credential,env:{DB:db,API_KEY:'retired-instance'} as unknown as AuthEnv};
}
const request=(key:string,path='/api/domains/1/health-report',extra:Record<string,string>={}) => new Request('https://i.example.com'+path,{headers:{'x-api-key':key,...extra}});
describe('explicit expiring API credentials',()=>{
 it('uses current named service identity and finite grant in both credential transports',async()=>{
  const f=await fixture();
  const x=await requireAuth(request(f.credential.key),f.env);
  expect(x).toMatchObject({kind:'service',workspaceId:'ws_default',access:{principalId:'svc'}});
  expect(await requireAuth(new Request('https://i.example.com/api/domains/1/health-report',{headers:{authorization:`Bearer ${f.credential.key}`}}),f.env)).toMatchObject({kind:'service'});
  await expect(requireAuth(request(f.credential.key,'/api/domains/2/health-report'),f.env)).rejects.toThrow('not authorized');
  await expect(requireAuth(request(f.credential.key,'/api/domains'),f.env)).rejects.toThrow();
 });
 it('does not let workspace headers change a service identity',async()=>{
  const f=await fixture();
  await expect(authenticate(request(f.credential.key,undefined,{'x-workspace-id':'guessed'}),f.env)).rejects.toThrow('workspace');
 });
 it('rejects expired, revoked and disabled credentials on the next authentication',async()=>{
  for(const failure of ['expiry','revoked','disabled']) {
   const f=await fixture();
   if(failure==='expiry') f.db.sqlite.exec('UPDATE access_credentials SET expires_at=1');
   if(failure==='revoked') await f.q.access.credentials.revoke(f.credential.id,1);
   if(failure==='disabled') await f.q.access.principals.disable('svc',1);
   expect(await authenticate(request(f.credential.key),f.env)).toBeNull();
  }
 });
 it('rejects prelaunch instance and ia_ broad credentials ',async()=>{
  const f=await fixture();
  expect(await authenticate(request('retired-instance'),f.env)).toBeNull();
  expect(await resolveApiKey(f.db,'ia_old')).toBeNull();
 });
 it('stores hashes only and never returns credential hashes from owner listing',async()=>{
  const f=await fixture();
  expect(f.credential.key).toMatch(/^ias_/);
  expect(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM access_credentials').get())).not.toContain(f.credential.key);
  expect(await f.q.access.credentials.list()).toMatchObject([{id:f.credential.id,prefix:f.credential.prefix}]);
  expect(JSON.stringify(await f.q.access.credentials.list())).not.toContain('key_hash');
 });
});
