// GET /api/domains/summaries: the overview's one request for every domain's stored DNS facts and report totals.
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(n: number): Env {
  const db = createMigratedD1();
  const ins = db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dmarc_policy, dmarc_pct, dmarc_sp, spf_lookup_count) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= n; i++) ins.run(i, `d${i}.com`, 'rua@r.test', 'reject', i === 1 ? 10 : 100, 'reject', i === 2 ? 12 : 3);
  // d1: one report of 100 messages with two records, so a join that repeats the report would double it.
  db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id) VALUES (1, 1, 'g', 'r1', ?, ?, 100, 90, 10, 'ws_default')").run(NOW - 3600, NOW);
  const rec = db.sqlite.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, spf_result, dkim_result, header_from, workspace_id) VALUES (1, ?, ?, 'none', 'pass', 'pass', 'd1.com', 'ws_default')");
  rec.run('1.1.1.1', 60);
  rec.run('2.2.2.2', 40);
  db.sqlite.exec("INSERT INTO workspaces (id, name) VALUES ('ws_other', 'Other')");
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id) VALUES (999, 'other-secret.com', 'r@x', 'ws_other')").run();
  return { DB: db as unknown as D1Database, API_KEY: 'k' } as unknown as Env;
}
const get = async (env: Env, path: string) => handleApi(new Request(`https://api.readysetmail.com${path}`), env, ctx);

describe('GET /api/domains/summaries', () => {
  it('returns every domain of the workspace with pct, sp, SPF lookups and report totals counted once', async () => {
    const res = await get(makeEnv(3), '/api/domains/summaries');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summaries.map((s: any) => s.domain)).toEqual(['d1.com', 'd2.com', 'd3.com']);
    expect(body.next_after).toBeNull();
    expect(body.window_days).toBe(30);
    expect(body.summaries[0]).toMatchObject({ dmarc_pct: 10, dmarc_sp: 'reject', total_messages: 100, pass_messages: 90, dkim_total: 100 });
    expect(body.summaries[1]).toMatchObject({ spf_lookup_count: 12 });
    expect(JSON.stringify(body)).not.toContain('other-secret.com');
  });

  it('pages by id', async () => {
    const env = makeEnv(5);
    const one = await (await get(env, '/api/domains/summaries?limit=2')).json() as any;
    expect(one.summaries.map((s: any) => s.domain_id)).toEqual([1, 2]);
    expect(one.next_after).toBe(2);
    const two = await (await get(env, `/api/domains/summaries?limit=2&after=${one.next_after}`)).json() as any;
    expect(two.summaries.map((s: any) => s.domain_id)).toEqual([3, 4]);
    const three = await (await get(env, `/api/domains/summaries?limit=2&after=${two.next_after}`)).json() as any;
    expect(three.summaries.map((s: any) => s.domain_id)).toEqual([5]);
    expect(three.next_after).toBeNull();
  });

  it.each(['limit=0', 'limit=201', 'limit=x', 'after=-1', 'after=abc'])('refuses %s', async (q) => {
    expect((await get(makeEnv(1), `/api/domains/summaries?${q}`)).status).toBe(400);
  });
});
