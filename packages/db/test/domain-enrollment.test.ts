import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '../src/testing';
import { forWorkspace } from '../src';

describe('atomic domain and product mapping insert', () => {
 it('retains original insert metadata and parent detection while binding only the new row', async () => {
  const db = createMigratedD1(), q = forWorkspace(db, 'ws_default');
  await q.access.products.create({ id: 'p', name: 'P' });
  const parent = await q.domains.insert({ domain: 'example.com', rua_address: '' });
  const result = await q.domains.insert({ domain: 'mail.example.com', rua_address: '', verified_via: 'txt' }, 'p');
  expect(result.meta.changes).toBe(1);
  expect(await q.domains.getById(result.meta.last_row_id as number)).toMatchObject({ domain: 'mail.example.com', parent_id: parent.meta.last_row_id });
  expect(await q.access.products.mappings('p')).toEqual([{ domain_id: result.meta.last_row_id, domain: 'mail.example.com' }]);
 });
 it('rolls back the domain when mapping insert fails and never maps a duplicate existing row', async () => {
  const db = createMigratedD1(), q = forWorkspace(db, 'ws_default');
  await q.access.products.create({ id: 'p', name: 'P' });
  db.sqlite.exec("CREATE TRIGGER reject_product_mapping BEFORE INSERT ON product_domains BEGIN SELECT RAISE(ABORT, 'injected mapping failure'); END;");
  await expect(q.domains.insert({ domain: 'new.example.com', rua_address: '' }, 'p')).rejects.toThrow('injected mapping failure');
  expect(await q.domains.getByName('new.example.com')).toBeNull();
  expect(await q.access.products.mappings('p')).toEqual([]);
  db.sqlite.exec('DROP TRIGGER reject_product_mapping');
  await q.domains.insert({ domain: 'existing.example.com', rua_address: '' });
  await expect(q.domains.insert({ domain: 'existing.example.com', rua_address: '' }, 'p')).rejects.toThrow('UNIQUE');
  expect(await q.access.products.mappings('p')).toEqual([]);
 });
});
