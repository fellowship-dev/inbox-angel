import { it, expect, vi } from 'vitest';
import { makeTenant } from '../../helpers/tenant';
import { TokenCrypto } from '../../../src/connections/crypto';
import { connectGoogle, disconnectGoogle } from '../../../src/metrics/google-postmaster/connection';
import { syncGoogleMetrics } from '../../../src/metrics/google-postmaster/sync';
import { getGoogleEvidence } from '../../../src/metrics/store';
const window={since:1790812800,until:1790985600};const config={clientId:'fixture',clientSecret:'fixture'};
async function world(){const tenant=makeTenant();const id=Number((await tenant.scope.domains.insert({domain:'example.com',rua_address:''})).meta.last_row_id);const crypto=TokenCrypto.fromEnv({TOKEN_ENCRYPTION_KEY:btoa('x'.repeat(32))});await connectGoogle(tenant.scope,id,crypto,{access:'fixture',refresh:'fixture',expiresAt:9999999999});return {tenant,id,crypto};}
const row={name:'domains/example.com/domainStats/opaque',metric:'spam_rate',date:{year:2026,month:10,day:1},value:{doubleValue:0}};
it('deduplicates retry observations, preserves explicit zero, keeps cached history after failed refresh',async()=>{
 const {tenant,id,crypto}=await world();const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(Response.json({domainStats:[row]})));
 await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher);await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher);
 let evidence=await getGoogleEvidence(tenant.scope,id,window);expect(evidence.data?.observations).toHaveLength(1);expect(evidence.data?.observations[0]).toMatchObject({value:0,denominator:null});
 evidence=await syncGoogleMetrics(tenant.scope,id,crypto,config,window,vi.fn().mockResolvedValue(new Response('',{status:429})));
 expect(evidence).toMatchObject({status:'available',reason:'rate_limited',data:{stale:true,connectionStatus:'rate_limited'}});expect(evidence.data?.observations).toHaveLength(1);
 evidence=await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher);expect(evidence.data?.stale).toBe(false);
});
it('empty response never manufactures zero; errors without history expose no data',async()=>{
 const {tenant,id,crypto}=await world();expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,vi.fn().mockResolvedValue(Response.json({})))).toMatchObject({status:'unavailable',reason:'no_data',data:null});
 expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,vi.fn().mockResolvedValue(new Response('',{status:403})))).toMatchObject({status:'error',reason:'permission_denied',data:null});
});
it('disconnect removes credential material but retains observations and never calls provider',async()=>{
 const {tenant,id,crypto}=await world();await syncGoogleMetrics(tenant.scope,id,crypto,config,window,vi.fn().mockResolvedValue(Response.json({domainStats:[row]})));await disconnectGoogle(tenant.scope,id);
 expect((await tenant.scope.metrics.secret(id))?.token_envelope).toBeNull();const fetcher=vi.fn();expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher)).toMatchObject({status:'available',reason:'disconnected',data:{stale:true}});expect(fetcher).not.toHaveBeenCalled();
});
it('workspace/domain guesses cannot query, connect or read foreign evidence',async()=>{
 const {tenant,id,crypto}=await world();const foreign=makeTenant({db:tenant.db,workspaceId:'foreign'});
 expect(await foreign.scope.metrics.secret(id)).toBeUndefined();await expect(connectGoogle(foreign.scope,id,crypto,{access:'fixture'})).rejects.toThrow('Domain not found');await expect(getGoogleEvidence(foreign.scope,id,window)).rejects.toMatchObject({status:404});await expect(syncGoogleMetrics(foreign.scope,id,crypto,config,window,vi.fn())).rejects.toMatchObject({status:404});
});
it('envelopes cannot be transplanted across workspace or connection identity',async()=>{
 const {tenant,id,crypto}=await world();const secret=await tenant.scope.metrics.secret(id);await expect(crypto.open(secret!.token_envelope!,`foreign|${secret!.id}`)).rejects.toThrow();await expect(crypto.open(secret!.token_envelope!,`${tenant.workspaceId}|other`)).rejects.toThrow();expect(JSON.stringify(await tenant.scope.metrics.status(id))).not.toContain('ia1.');
});
it('refreshes encrypted expired credentials with separate Postmaster OAuth client; revoked grant is explicit',async()=>{
 const {tenant,id,crypto}=await world();await connectGoogle(tenant.scope,id,crypto,{access:'expired-fixture',refresh:'refresh-fixture',expiresAt:1});
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'new-fixture',expires_in:3600})).mockResolvedValueOnce(Response.json({domainStats:[row]}));
 expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher)).toMatchObject({status:'available'});
 expect(fetcher.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
 expect(fetcher.mock.calls[0][1].body.get('grant_type')).toBe('refresh_token');
 expect((await tenant.scope.metrics.secret(id))?.token_envelope).not.toContain('new-fixture');
 await connectGoogle(tenant.scope,id,crypto,{access:'expired-fixture',refresh:'revoked-fixture',expiresAt:1});
 expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,vi.fn().mockResolvedValue(Response.json({error:'invalid_grant'},{status:400})))).toMatchObject({status:'available',reason:'token_revoked',data:{stale:true}});
});
it('known revoked grant stays unusable until an explicit reconnect',async()=>{
 const {tenant,id,crypto}=await world();await syncGoogleMetrics(tenant.scope,id,crypto,config,window,vi.fn().mockResolvedValue(new Response('',{status:401})));
 const fetcher=vi.fn().mockResolvedValue(Response.json({}));
 expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher)).toMatchObject({reason:'token_revoked'});expect(fetcher).not.toHaveBeenCalled();
 await connectGoogle(tenant.scope,id,crypto,{access:'reconnected-fixture',expiresAt:9999999999});await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher);expect(fetcher).toHaveBeenCalledOnce();
});
it('disconnect after page one prevents a new token-bearing page request',async()=>{
 const {tenant,id,crypto}=await world();const fetcher=vi.fn().mockImplementationOnce(async()=>{await disconnectGoogle(tenant.scope,id);return Response.json({nextPageToken:'next'});}).mockResolvedValue(Response.json({}));
 expect(await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher)).toMatchObject({reason:'disconnected'});expect(fetcher).toHaveBeenCalledOnce();
});
it('disconnect while decrypting blocks the first query and disconnect while decrypting expired grant blocks refresh',async()=>{
 for(const expiresAt of [9999999999,1]) {
  const {tenant,id,crypto}=await world();await connectGoogle(tenant.scope,id,crypto,{access:'fixture',refresh:'fixture',expiresAt});
  const open=crypto.open.bind(crypto);vi.spyOn(crypto,'open').mockImplementationOnce(async(...args)=>{const material=await open(...args);await disconnectGoogle(tenant.scope,id);return material;});
  const fetcher=vi.fn();await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher);expect(fetcher).not.toHaveBeenCalled();
 }
});
it('a stale failed collection cannot clear a new explicit reconnect',async()=>{
 const {tenant,id,crypto}=await world();const fetcher=vi.fn().mockImplementationOnce(async()=>{await connectGoogle(tenant.scope,id,crypto,{access:'replacement-fixture',expiresAt:9999999999});return new Response('',{status:401});});
 await syncGoogleMetrics(tenant.scope,id,crypto,config,window,fetcher);expect(await tenant.scope.metrics.status(id)).toMatchObject({status:'connected'});expect((await tenant.scope.metrics.secret(id))?.token_envelope).toBeTruthy();
});
