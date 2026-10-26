import { describe, it, expect, vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { forWorkspace } from '@inbox-angel/db';
import { TenantContext } from '../../src/tenancy/context';
import { resolveAccessSubject, authorizeResource } from '../../src/access/resolve';
import { commitVerifiedDomain, enrollDomain, assertAgentEnrollmentSafe } from '../../src/domains/service';
import type { BoundEnv } from '../../src/index';
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

async function fixture() {
 const db = createMigratedD1(), q = forWorkspace(db, 'ws_default');
 await q.access.products.create({ id: 'a', name: 'A' });
 await q.access.products.create({ id: 'b', name: 'B' });
 await q.access.principals.create({ id: 'svc', name: 'A setup', kind: 'service' });
 await q.access.grants.create({ id: 'g', workspace_id: 'ws_default', principal_id: 'svc', product_id: 'a', domain: 'new.example.com', actions: '["domains:manage","reports:read","resources:read"]', expires_at: Math.floor(Date.now() / 1000) + 3600 });
 const access = (await resolveAccessSubject(db, 'svc'))!;
 const tenant = new TenantContext({ env: { DB: db, MODE: 'selfhost' } as unknown as BoundEnv, workspaceId: 'ws_default', access });
 return { db, q, access, tenant };
}

describe('exact product enrollment', () => {
 it('creates one domain and its mapping together, then resumes across reconnect and authorizes reports', async () => {
  const f = await fixture();
  const first = await enrollDomain(f.tenant, 'new.example.com', undefined, undefined, undefined, { productId: 'a' });
  expect(first).toMatchObject({ resumed: false, domain: { domain: 'new.example.com' } });
  expect(await f.q.access.products.mappings('a')).toMatchObject([{ domain: 'new.example.com' }]);
  const reconnected = new TenantContext({ env: f.tenant.env, workspaceId: 'ws_default', access: (await resolveAccessSubject(f.db, 'svc'))! });
  const again = await enrollDomain(reconnected, 'new.example.com', undefined, undefined, undefined, { productId: 'a' });
  expect(again).toMatchObject({ resumed: true, domain: { id: first.domain!.id } });
  expect(await f.q.domains.list()).toHaveLength(1);
  await expect(authorizeResource(f.db, reconnected.access!, 'reports:read', { workspaceId: 'ws_default', productId: 'a', domain: 'new.example.com' })).resolves.toBeUndefined();
 });
 it('never attaches an already known private domain, even when an exact pregrant exists', async () => {
  const f = await fixture();
  const inserted = await f.q.domains.insert({ domain: 'new.example.com', rua_address: '' });
  await f.q.access.products.map('b', inserted.meta.last_row_id as number);
  await expect(commitVerifiedDomain(f.tenant, 'new.example.com', 'txt', undefined, undefined, undefined, { productId: 'a' })).rejects.toMatchObject({ status: 403 });
  expect(await f.q.access.products.mappings('a')).toEqual([]);
  expect(await f.q.access.products.mappings('b')).toHaveLength(1);
 });
 it('a concurrent duplicate resumes only when the winner already has the exact product mapping', async () => {
  for (const mapped of [false, true]) {
   const f = await fixture();
   const insert = f.tenant.scope.domains.insert.bind(f.tenant.scope.domains);
   vi.spyOn(f.tenant.scope.domains, 'insert').mockImplementationOnce(async (domain, productId) => {
    await f.q.domains.insert(domain, mapped ? 'a' : undefined);
    return insert(domain, productId);
   });
   const enrollment = commitVerifiedDomain(f.tenant, 'new.example.com', 'txt', undefined, undefined, undefined, { productId: 'a' });
   if (mapped) await expect(enrollment).resolves.toMatchObject({ resumed: true, domain: { domain: 'new.example.com' } });
   else await expect(enrollment).rejects.toMatchObject({ status: 403 });
   expect(await f.q.domains.list()).toHaveLength(1);
   expect(await f.q.access.products.mappings('a')).toHaveLength(mapped ? 1 : 0);
  }
 });
 it('fresh revocation, missing actor and guessed product/domain deny before inserting or claiming', async () => {
  const f = await fixture();
  await expect(enrollDomain(f.tenant, 'sibling.example.com', undefined, undefined, undefined, { productId: 'a' })).rejects.toThrow();
  await expect(enrollDomain(f.tenant, 'new.example.com', undefined, undefined, undefined, { productId: 'b' })).rejects.toThrow();
  await f.q.access.grants.revoke('g', 1);
  await expect(enrollDomain(f.tenant, 'new.example.com', undefined, undefined, undefined, { productId: 'a' })).rejects.toThrow();
  const noActor = new TenantContext({ env: f.tenant.env, workspaceId: 'ws_default' });
  await expect(commitVerifiedDomain(noActor, 'new.example.com', 'txt', undefined, undefined, undefined, { productId: 'a' })).rejects.toMatchObject({ status: 403 });
  expect(await f.q.domains.list()).toEqual([]);
  expect(await f.q.claims.list()).toEqual([]);
 });
 it('blocks legacy transfer before admission or verified commit without touching the holder', async () => {
  const f = await fixture();
  f.db.sqlite.exec("INSERT INTO workspaces(id,name) VALUES ('legacy','Legacy'); INSERT INTO domains(domain,rua_address,workspace_id,verified_via,dns_record_id) VALUES ('new.example.com','','legacy','legacy','provider-record');");
  await expect(assertAgentEnrollmentSafe(f.tenant, 'new.example.com')).rejects.toMatchObject({ status: 409 });
  await expect(enrollDomain(f.tenant, 'new.example.com', undefined, undefined, undefined, { productId: 'a' })).rejects.toMatchObject({ status: 409 });
  await expect(commitVerifiedDomain(f.tenant, 'new.example.com', 'txt', undefined, undefined, undefined, { productId: 'a' })).rejects.toMatchObject({ status: 409 });
  expect(f.db.sqlite.prepare("SELECT domain,dns_record_id,evicted_at FROM domains WHERE workspace_id='legacy'").get()).toEqual({ domain: 'new.example.com', dns_record_id: 'provider-record', evicted_at: null });
  expect(await f.q.claims.list()).toEqual([]);
  const browser = new TenantContext({ env: f.tenant.env, workspaceId: 'ws_default', access: { ...f.access, session: true, kind: 'human' } });
  await expect(assertAgentEnrollmentSafe(browser, 'new.example.com')).resolves.toBeUndefined();
 });
});
