import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { makeEnv, setupOwner, req, ctx, call } from '../auth/helpers';
import { handleAccessRoutes } from '../../src/access/routes';

describe('owner access management HTTP adapter', () => {
 it('creates product, service, exact consent and one-time credential; service cannot administer access',async()=>{
  const db=createMigratedD1(), env=makeEnv(db), token=await setupOwner(env);
  expect((await call(env,'POST','/api/keys',{key:token,body:{name:'old broad key'}})).status).toBe(410);
  const send=async(method:string,path:string,body?:unknown,key=token)=> (await handleAccessRoutes(req(method,path,{key,body}),env,ctx))!;
  const product=await (await send('POST','/api/access/products',{name:'A'})).json() as any;
  expect(product.id).toBeTruthy();
  const enrolled=await (await call(env,'POST','/api/domains',{key:token,body:{domain:'mail.example.com'}})).json() as any;
  const mappingPath=`/api/access/products/${product.id}/domains/${enrolled.domain.id}`;
  expect((await send('PUT',mappingPath)).status).toBe(200);
  expect((await (await send('GET','/api/resources')).json() as any).domains[0].mappedProductIds).toContain(product.id);
  expect((await send('DELETE',mappingPath)).status).toBe(200);
  expect((await send('PUT',mappingPath)).status).toBe(200);
  const principal=await (await send('POST','/api/access/principals',{name:'A worker',kind:'service'})).json() as any;
  const expires_at=Math.floor(Date.now()/1000)+3600;
  expect((await send('POST','/api/access/grants',{principal_id:principal.id,product_id:product.id,domain:'mail.example.com',actions:['resources:read','reports:read'],expires_at})).status).toBe(201);
  const credential=await (await send('POST','/api/access/credentials',{principal_id:principal.id,name:'CI',expires_at})).json() as any;
  expect(credential.key).toMatch(/^ias_/);
  const listing=await (await send('GET','/api/access')).json() as any;
  expect(listing.credentials).toHaveLength(1);
  expect(JSON.stringify(listing)).not.toContain(credential.key);
  expect(JSON.stringify(listing)).not.toContain('key_hash');
  expect((await send('POST','/api/access/principals',{name:'stronger',kind:'service'},credential.key)).status).toBe(403);
  expect((await send('DELETE',`/api/access/credentials/${credential.id}`)).status).toBe(200);
  expect((await send('GET','/api/resources',undefined,credential.key)).status).toBe(401);
 });
 it('requires exact finite consent and explicit expiry',async()=>{
  const db=createMigratedD1(),env=makeEnv(db),token=await setupOwner(env);
  const send=async(body:unknown)=> (await handleAccessRoutes(req('POST','/api/access/grants',{key:token,body}),env,ctx))!;
  const principal=await (await handleAccessRoutes(req('POST','/api/access/principals',{key:token,body:{name:'A',kind:'service'}}),env,ctx))!.json() as any;
  expect((await send({principal_id:principal.id,actions:['reports:read'],expires_at:Math.floor(Date.now()/1000)+3600})).status).toBe(400);
  expect((await send({principal_id:principal.id,domain:'a.example.com',actions:['reports:read']})).status).toBe(400);
 });
});
