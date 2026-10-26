import { it, expect, vi, afterEach } from 'vitest';
import { forWorkspace } from '@inbox-angel/db';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { makeEnv, setupOwner, req, ctx, BASE, inviteAndAccept } from '../../auth/helpers';
import { handleGoogleMetricRoutes } from '../../../src/metrics/routes';
import { AccessService } from '../../../src/access/service';
import { requireAuth } from '../../../src/api/auth';
const root='/api/metrics/google';
afterEach(()=>vi.restoreAllMocks());
async function world(){const db=createMigratedD1(),env=makeEnv(db,{BETTER_AUTH_URL:BASE,TOKEN_ENCRYPTION_KEY:btoa('x'.repeat(32)),GOOGLE_POSTMASTER_CLIENT_ID:'provider-fixture-id',GOOGLE_POSTMASTER_CLIENT_SECRET:'provider-fixture-secret'}),token=await setupOwner(env),scope=forWorkspace(db,'ws_default');const id=Number((await scope.domains.insert({domain:'example.com',rua_address:''})).meta.last_row_id);const send=(method:string,path:string,body?:unknown,key=token,headers:Record<string,string>={Origin:BASE})=>handleGoogleMetricRoutes(req(method,root+path,{key,body,headers}),env,ctx).then(r=>r!);return {db,env,token,scope,id,send};}
async function start(w:Awaited<ReturnType<typeof world>>){const response=await w.send('POST','/oauth/start',{domain_id:w.id});expect(response.status).toBe(200);const auth=new URL((await response.json() as any).authorize_url);return {auth,state:auth.searchParams.get('state')!,cookie:response.headers.get('Set-Cookie')!.split(';')[0]};}
it('only signed-in owners manage provider grants; service grants cannot elevate',async()=>{
 const w=await world();expect((await handleGoogleMetricRoutes(req('GET',root+'/connections'),w.env,ctx))!.status).toBe(401);
 const admin=await inviteAndAccept(w.env,w.token,'admin@example.com','admin');expect((await w.send('GET','/connections',undefined,admin)).status).toBe(403);
 const auth=await requireAuth(req('GET','/api/resources',{key:w.token}),w.env,ctx);const access=new AccessService(w.env.DB!,auth.access!);const p=await access.createPrincipal('ws_default','fixture','service');const credential=await access.issueCredential('ws_default',p.id,'fixture',Math.floor(Date.now()/1000)+3600);
 expect((await w.send('POST','/oauth/start',{domain_id:w.id},credential.key)).status).toBe(403);
});
it('browser Origin is required; unknown or foreign domain cannot start or disconnect',async()=>{
 const w=await world();expect((await w.send('POST','/oauth/start',{domain_id:w.id},w.token,{})).status).toBe(403);expect((await w.send('POST','/oauth/start',{domain_id:w.id},w.token,{Origin:'https://evil.example'})).status).toBe(403);
 expect((await w.send('POST','/oauth/start',{domain_id:999})).status).toBe(404);expect((await w.send('DELETE','/domains/999')).status).toBe(404);
 expect(JSON.stringify(await (await w.send('GET','/connections')).json())).not.toContain('provider-fixture-secret');
});
it('uses distinct readonly provider consent, PKCE, canonical callback and browser binding; callback is single-use',async()=>{
 const w=await world(),flow=await start(w);expect(flow.auth.origin).toBe('https://accounts.google.com');expect(flow.auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/postmaster.traffic.readonly');expect(flow.auth.searchParams.get('code_challenge_method')).toBe('S256');expect(flow.auth.searchParams.get('redirect_uri')).toBe(BASE+root+'/oauth/callback');expect(flow.auth.searchParams.has('client_secret')).toBe(false);
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({access_token:'never-return-this-access',refresh_token:'never-return-this-refresh',expires_in:3600,scope:flow.auth.searchParams.get('scope')}));
 const path='/oauth/callback?'+new URLSearchParams({state:flow.state,code:'provider-code-fixture'});
 expect((await w.send('GET',path)).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();
 const response=await w.send('GET',path,undefined,w.token,{Cookie:flow.cookie});expect(response.status).toBe(303);expect(response.headers.get('Location')).toBe(BASE+'/#/w/ws_default/settings?google_postmaster=connected');expect(fetcher).toHaveBeenCalledOnce();
 const list=JSON.stringify(await (await w.send('GET','/connections')).json());expect(list).toContain('connected');expect(list).not.toMatch(/never-return|ia1\.|token_envelope|provider-fixture-secret/);
 expect((await w.send('GET',path,undefined,w.token,{Cookie:flow.cookie})).status).toBe(400);expect(fetcher).toHaveBeenCalledOnce();
 fetcher.mockResolvedValueOnce(Response.json({domainStats:[{name:'domains/example.com/domainStats/fixture',metric:'spam_rate',date:{year:2026,month:10,day:1},value:{doubleValue:0}}]}));
 const sync=await w.send('POST',`/domains/${w.id}/sync`,{since:1790812800,until:1790985600});expect(sync.status).toBe(200);expect(await sync.json()).toMatchObject({status:'available',data:{observations:[{metric:'spam_rate',value:0}]}});
 expect((await w.send('DELETE',`/domains/${w.id}`)).status).toBe(200);expect((await w.scope.metrics.secret(w.id))?.token_envelope).toBeNull();expect(await w.scope.metrics.read(w.id,'2026-10-01','2026-10-03')).toHaveLength(1);
});
it('callback rechecks owner authority and domain binding rather than trusting query selectors',async()=>{
 const w=await world(),flow=await start(w);const auth=await requireAuth(req('GET','/api/resources',{key:w.token}),w.env,ctx);
 w.db.sqlite.prepare("UPDATE memberships SET role='admin' WHERE user_id=?").run(auth.user!.id);
 const fetcher=vi.spyOn(globalThis,'fetch');expect((await w.send('GET','/oauth/callback?'+new URLSearchParams({state:flow.state,code:'fixture',domain_id:'999'}),undefined,w.token,{Cookie:flow.cookie})).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();
});
it('missing deployment config is precise; denied provider scope cannot create a connection',async()=>{
 const w=await world();const env={...w.env,GOOGLE_POSTMASTER_CLIENT_SECRET:undefined};expect((await handleGoogleMetricRoutes(req('POST',root+'/oauth/start',{key:w.token,body:{domain_id:w.id},headers:{Origin:BASE}}),env,ctx))!.status).toBe(503);
 const flow=await start(w);vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({access_token:'fixture',scope:'openid email'}));const response=await w.send('GET','/oauth/callback?'+new URLSearchParams({state:flow.state,code:'fixture'}),undefined,w.token,{Cookie:flow.cookie});expect(response.status).toBe(502);expect(await w.scope.metrics.status(w.id)).toBeUndefined();
});
it('state cannot cross workspaces or be modified, and expires before token exchange',async()=>{
 const w=await world(),flow=await start(w);const auth=await requireAuth(req('GET','/api/resources',{key:w.token}),w.env,ctx);
 w.db.sqlite.prepare("INSERT INTO workspaces (id,name) VALUES ('ws_other','Other')").run();w.db.sqlite.prepare("INSERT INTO memberships (workspace_id,user_id,role) VALUES ('ws_other',?,'owner')").run(auth.user!.id);
 const fetcher=vi.spyOn(globalThis,'fetch');const callback=(state:string)=>'/oauth/callback?'+new URLSearchParams({state,code:'fixture'});
 expect((await w.send('GET',callback(flow.state),undefined,w.token,{Cookie:flow.cookie,'x-workspace-id':'ws_other'})).status).toBe(400);
 expect((await w.send('GET',callback(flow.state+'modified'),undefined,w.token,{Cookie:flow.cookie})).status).toBe(400);
 const originalNow=Date.now();vi.spyOn(Date,'now').mockReturnValue(originalNow+601000);
 expect((await w.send('GET',callback(flow.state),undefined,w.token,{Cookie:flow.cookie})).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();
});
it('nondefault workspace survives browser callback without a selector; membership revocation is denied',async()=>{
 const w=await world();const auth=await requireAuth(req('GET','/api/resources',{key:w.token}),w.env,ctx);
 w.db.sqlite.prepare("INSERT INTO workspaces (id,name) VALUES ('ws_other','Other')").run();w.db.sqlite.prepare("INSERT INTO memberships (workspace_id,user_id,role) VALUES ('ws_other',?,'owner')").run(auth.user!.id);
 const other=forWorkspace(w.db,'ws_other'),id=Number((await other.domains.insert({domain:'other.example.com',rua_address:''})).meta.last_row_id);
 const begin=async()=>{const res=await w.send('POST','/oauth/start',{domain_id:id},w.token,{Origin:BASE,'X-Workspace-Id':'ws_other'});expect(res.status).toBe(200);const state=new URL((await res.json() as any).authorize_url).searchParams.get('state')!;return {state,cookie:res.headers.get('Set-Cookie')!.split(';')[0]};};
 const flow=await begin();const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({access_token:'fixture',refresh_token:'fixture',scope:'https://www.googleapis.com/auth/postmaster.traffic.readonly'}));
 expect((await w.send('GET','/oauth/callback?'+new URLSearchParams({state:flow.state,code:'fixture'}),undefined,w.token,{Cookie:flow.cookie})).status).toBe(303);expect(await other.metrics.status(id)).toMatchObject({status:'connected'});expect(await w.scope.metrics.status(id)).toBeUndefined();
 const pending=await begin();w.db.sqlite.prepare("DELETE FROM memberships WHERE workspace_id='ws_other' AND user_id=?").run(auth.user!.id);fetcher.mockClear();
 expect((await w.send('GET','/oauth/callback?'+new URLSearchParams({state:pending.state,code:'fixture'}),undefined,w.token,{Cookie:pending.cookie})).status).toBe(403);expect(fetcher).not.toHaveBeenCalled();
});
