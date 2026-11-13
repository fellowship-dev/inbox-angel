// Item 7: a bulk import counts the workspace's domains once, not once per row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forWorkspace } from '@inbox-angel/db';
import { hosted, json, nxdomain } from './helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: null, manual: true }),
}));
beforeEach(nxdomain);
afterEach(() => vi.unstubAllGlobals());

/** Count how many times the statement behind `scope.domains.list()` is prepared. */
function countListQueries(db: any, ws: string) {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
  void forWorkspace(db, ws).domains.list();
  const listSql = seen[seen.length - 1];
  seen.length = 0;
  return () => seen.filter(s => s === listSql).length;
}

describe('bulk import', () => {
  it('counts the workspace once for a 10-row import, and the cap still holds', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '20' });
    const a = await w.user('a@example.com');
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(a.ws);
    const listQueries = countListQueries(w.db, a.ws);
    const domains = Array.from({ length: 10 }, (_, i) => `s${i}.acme.com`).join('\n');
    const body = await json(await w.api(a, 'POST', '/api/domains/bulk-import', { domains }));
    expect(body.results.map((r: any) => r.status)).toEqual(Array(10).fill('imported'));
    expect(listQueries()).toBe(1);
  });

  it('the local counter stops the import at the cap, with the insert as the enforcement', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '4' });
    const a = await w.user('a@example.com');
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(a.ws);
    const listQueries = countListQueries(w.db, a.ws);
    const domains = Array.from({ length: 6 }, (_, i) => `s${i}.acme.com`).join('\n');
    const body = await json(await w.api(a, 'POST', '/api/domains/bulk-import', { domains }));
    expect(body.results.map((r: any) => r.code ?? r.status)).toEqual(['imported', 'imported', 'imported', 'plan_limit', 'plan_limit', 'plan_limit']);
    expect(w.rows('SELECT COUNT(*) AS n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', a.ws)[0].n).toBe(4);
    expect(listQueries()).toBe(1);
  });

  it('a domain added by someone else mid-import is still caught by the insert (the count is advisory)', async () => {
    const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '3' });
    const a = await w.user('a@example.com');
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('acme.com', 'x', ?, 'txt')").run(a.ws);
    // after the import's one count, another request fills the workspace
    const prepare = w.db.prepare.bind(w.db);
    let filled = false;
    (w.db as any).prepare = (sql: string) => {
      const st = prepare(sql);
      if (!filled && /^\s*insert into "?domains"?\s*\(/i.test(sql)) {
        filled = true;
        w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('other1.com', 'x', ?, 'txt'), ('other2.com', 'x', ?, 'txt')").run(a.ws, a.ws);
      }
      return st;
    };
    const body = await json(await w.api(a, 'POST', '/api/domains/bulk-import', { domains: 'one.acme.com\ntwo.acme.com' }));
    expect(body.results.map((r: any) => r.code ?? r.status)).toEqual(['plan_limit', 'plan_limit']);
    expect(w.rows('SELECT COUNT(*) AS n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', a.ws)[0].n).toBe(3);
  });
});
