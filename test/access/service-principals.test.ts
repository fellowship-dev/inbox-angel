import { describe, it, expect } from 'vitest';
import { createMigratedD1, createTestD1, applyMigrations } from '@inbox-angel/db/testing';
import { forWorkspace } from '@inbox-angel/db';
import { AccessService } from '../../src/access/service';
import { resolveApiKey } from '../../src/auth/api-keys';
import { authorizeResource, authorizedDomains } from '../../src/access/resolve';
import type { AccessSubject } from '../../src/access/principal';
import { authorizeHttpRequest } from '../../src/access/http-policy';
const future = () => Math.floor(Date.now()/1000) + 3600;
function fixture() {
 const db = createMigratedD1();
 db.sqlite.exec("INSERT INTO users (id,email,name) VALUES ('u','u@example.com','Owner'); INSERT INTO memberships (workspace_id,user_id,role) VALUES ('ws_default','u','owner'); INSERT INTO workspaces (id,name) VALUES ('other','Other'), ('later','Later'); INSERT INTO memberships (workspace_id,user_id,role) VALUES ('other','u','owner');");
 const actor: AccessSubject = { principalId:'u', kind:'human', workspaceId:'ws_default', userId:'u', session:true, grants:[], memberships:[] };
 return { db, owner: new AccessService(db, actor) };
}
async function productFixture() {
 const { db, owner } = fixture();
 const scope = forWorkspace(db, 'ws_default');
 await scope.domains.insert({ domain:'mail.example.com', rua_address:'r@example.com' });
 await scope.domains.insert({ domain:'other.example.com', rua_address:'r@example.com' });
 const a = await owner.createProduct('ws_default','A'), b = await owner.createProduct('ws_default','B');
 const domains = await scope.domains.list();
 await owner.mapDomain('ws_default',a.id,domains[0].id); await owner.mapDomain('ws_default',b.id,domains[1].id);
 const principal = await owner.createPrincipal('ws_default','A agent','service');
 const grant = await owner.grant({ workspaceId:'ws_default',principalId:principal.id,productId:a.id,domain:domains[0].domain,actions:['resources:read','reports:read'],expiresAt:future() });
 const key = await owner.issueCredential('ws_default',principal.id,'CI',future());
 const resolved = (await resolveApiKey(db,key.key))!;
 return { db,owner,scope,a,b,domains,principal,grant,key,resolved };
}
describe('service principals and HTTP isolation', () => {
 it('issues hashed expiring credentials and enforces exact products/domains before HTTP data reads', async () => {
  const f = await productFixture();
  expect(f.key.key).toMatch(/^ias_[A-Za-z0-9_-]{43}$/);
  const stored = f.db.sqlite.prepare('SELECT * FROM access_credentials').get();
  expect(JSON.stringify(stored)).not.toContain(f.key.key);
  const principal = {kind:'service' as const,viaCookie:false,user:null,workspaceId:'ws_default',role:'admin' as const,access:f.resolved.access};
  await expect(authorizeHttpRequest(new Request(`https://i.test/api/domains/${f.domains[0].id}/health-report?product_id=${f.a.id}`),f.db,principal)).resolves.toBeUndefined();
  for (const url of [`/api/domains/${f.domains[1].id}/health-report?product_id=${f.a.id}`,`/api/domains/${f.domains[0].id}/health-report?product_id=${f.b.id}`,'/api/domains','/api/team','/api/keys']) await expect(authorizeHttpRequest(new Request('https://i.test'+url),f.db,principal)).rejects.toThrow();
  expect(await authorizedDomains(f.db,f.resolved.access,{workspaceId:'ws_default',productId:f.a.id})).toMatchObject([{domain:'mail.example.com',coverage:'shared-domain'}]);
  expect(await authorizedDomains(f.db,f.resolved.access,{workspaceId:'ws_default',productId:f.b.id})).toEqual([]);
  await expect(new AccessService(f.db,f.resolved.access).createPrincipal('ws_default','escalate','service')).rejects.toThrow();
 });
 it('denies the next authorization after key/grant revocation and principal disable without deleting history',async () => {
  for (const type of ['credentials','grants','principals'] as const) {
   const f = await productFixture(), target = {workspaceId:'ws_default',productId:f.a.id,domain:f.domains[0].domain};
   await authorizeResource(f.db,f.resolved.access,'reports:read',target);
   await f.owner.revoke('ws_default',type,type === 'credentials' ? f.key.id : type === 'grants' ? f.grant.id : f.principal.id);
   await expect(authorizeResource(f.db,f.resolved.access,'reports:read',target)).rejects.toThrow();
   expect((await f.scope.domains.list())).toHaveLength(2);
  }
 });
 it('mapping removal ends product access and only human owners may map',async () => {
  const f=await productFixture();
  await expect(new AccessService(f.db,f.resolved.access).mapDomain('ws_default',f.a.id,f.domains[1].id)).rejects.toThrow();
  await f.owner.mapDomain('ws_default',f.a.id,f.domains[0].id,true);
  await expect(authorizeResource(f.db,f.resolved.access,'reports:read',{workspaceId:'ws_default',productId:f.a.id,domain:f.domains[0].domain})).rejects.toThrow();
 });
 it('labels shared domain coverage without disclosing unconsented product identities',async () => {
  const f = await productFixture();
  await f.owner.mapDomain('ws_default', f.b.id, f.domains[0].id);
  const rows = await authorizedDomains(f.db, f.resolved.access, {workspaceId:'ws_default',productId:f.a.id});
  expect(rows).toHaveLength(1);
  expect(rows[0].coverage).toBe('shared-domain');
  expect(rows[0].mappedProductIds).toEqual([f.a.id]);
 });
 it('finite human consent does not expand after membership and demotion limits actions',async () => {
  const {db,owner}=fixture();
  const principal=await owner.createPrincipal('ws_default','Portfolio','human');
  await owner.grant({workspaceId:'ws_default',principalId:principal.id,domain:'a.example.com',actions:['reports:read','domains:manage'],expiresAt:future()});
  await owner.grant({workspaceId:'other',principalId:principal.id,domain:'b.example.com',actions:['reports:read'],expiresAt:future()});
  const key=await owner.issueCredential('ws_default',principal.id,'Portfolio',future());
  const actor=(await resolveApiKey(db,key.key))!.access;
  await authorizeResource(db,actor,'reports:read',{workspaceId:'other',domain:'b.example.com'});
  db.sqlite.exec("INSERT INTO memberships (workspace_id,user_id,role) VALUES ('later','u','owner')");
  await expect(authorizeResource(db,actor,'reports:read',{workspaceId:'later',domain:'b.example.com'})).rejects.toThrow();
  db.sqlite.exec("UPDATE memberships SET role='member' WHERE workspace_id='ws_default' AND user_id='u'");
  await expect(authorizeResource(db,actor,'domains:manage',{workspaceId:'ws_default',domain:'a.example.com'})).rejects.toThrow();
  await authorizeResource(db,actor,'reports:read',{workspaceId:'ws_default',domain:'a.example.com'});
 });
 it('invalidates legacy keys during migration and never resolves old prefixes',async () => {
  const d=createTestD1(); applyMigrations(d.sqlite,{through:'0005_trust_followups.sql'});
  d.sqlite.exec("INSERT INTO users (id,email,name) VALUES ('u','u@example.com','Owner'); INSERT INTO api_keys (id,user_id,workspace_id,name,prefix,key_hash) VALUES ('old','u','ws_default','old','ia_old','oldhash');");
  applyMigrations(d.sqlite);
  expect(d.sqlite.prepare("SELECT revoked_at FROM api_keys WHERE id='old'").get()).toMatchObject({revoked_at:expect.any(Number)});
  expect(await resolveApiKey(d,'ia_old')).toBeNull();
  expect(d.sqlite.prepare('SELECT count(*) AS n FROM access_grants').get()).toEqual({n:0});
 });
});
