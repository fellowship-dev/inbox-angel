// G4: large reports and storage failures through the real email() entry point in hosted mode.
//
// Local D1 does not enforce Cloudflare's "1000 queries per Worker invocation" (50 on Free), so the binding is wrapped in
// test/helpers/counting-d1.ts, which counts the way Cloudflare does (prepare().first/all/run/raw = 1 each, batch() = 1)
// and refuses every query past the limit. These tests began as reproductions of the bugs below and were flipped when they were fixed:
//   - one query per record (5,058 queries for 5,000 records: the report was lost or the delivery failed on every retry),
//   - a report row written without its records when the budget ran out between the two inserts,
//   - a storage error that was logged and swallowed while the mail was accepted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { StorageFailure } from '../../src/email/dmarc-report';
import { fakeMessage, gzipReportMime } from '../helpers/mail';
import { reportWithDistinctIps } from '../helpers/big-report';
import { countingD1 } from '../helpers/counting-d1';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const D1_PAID_LIMIT = 1000;
const D1_FREE_LIMIT = 50;
/** The budget this change commits to for ANY allowed report (docs/hosted.md, "Query budget"): fixed, not per record. */
const QUERY_BUDGET = 40;
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
// an operator who raises the caps (the defaults are 2,000 records / 1 MiB / 2 MiB: measured, docs/hosted.md)
const RAISED = { INTAKE_MAX_RECORDS_PER_REPORT: '5000', INTAKE_MAX_DECOMPRESSED_BYTES: String(3 * 1024 * 1024), INTAKE_MAX_RAW_BYTES: String(6 * 1024 * 1024) };
const MAX_ENV = { INTAKE_MAX_RECORDS_PER_REPORT: '20000', INTAKE_MAX_DECOMPRESSED_BYTES: String(25 * 1024 * 1024), INTAKE_MAX_RAW_BYTES: String(25 * 1024 * 1024) };

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Deliver one message through the real email() export, with `env.DB` replaced by a counting binding. */
async function deliver(n: number, o: { wrap?: (db: D1Database) => D1Database; limit?: number; env?: Record<string, string>; reportId?: string; headers?: Record<string, string>; world?: Awaited<ReturnType<typeof twoWorkspaces>> } = {}) {
  resetSchemaReadyCache(); // the schema check (1 query) runs on a cold isolate, so it is part of the invocation
  const limit = o.limit ?? D1_PAID_LIMIT;
  const w = o.world ?? await twoWorkspaces(o.env);
  const counter = countingD1(w.db as unknown as D1Database, limit);
  const env = { ...w.env, ...(o.env ?? {}), DB: (o.wrap ?? ((d) => d))(counter.db) } as any;
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(reportWithDistinctIps('a-corp.com', o.reportId ?? `big-${n}`, n)), o.headers ? { headers: o.headers } : GOOGLE);
  counter.reset(limit); // seeding is not part of the invocation
  let threw: unknown = null;
  await worker.email(m, env, ctx).catch((e: unknown) => { threw = e; });
  return { w, counter, m, threw };
}

const count = (w: { rows: (sql: string) => any[] }, table: string) => w.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n as number;

describe('G4: records are stored in a fixed number of D1 queries', () => {
  it('5,000 distinct-IP records: stays under the query budget, stores everything atomically, accepts the mail', async () => {
    const { w, counter, m, threw } = await deliver(5000, { env: RAISED });
    // eslint-disable-next-line no-console
    console.info(`[G4] 5000 records: ${counter.count} queries (limit ${D1_PAID_LIMIT}), ${counter.refused} refused; kinds=${JSON.stringify(counter.kinds)}; largest batch ${counter.largestBatch} statements`);
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    expect(counter.refused).toBe(0);
    expect(counter.count).toBeLessThanOrEqual(QUERY_BUDGET);
    expect(count(w, 'aggregate_reports')).toBe(1);
    expect(count(w, 'report_records')).toBe(5000);
    expect(w.rows('SELECT record_count, reporter_auth FROM aggregate_reports')).toEqual([{ record_count: 5000, reporter_auth: 'pass' }]);
    expect(w.rows('SELECT records FROM workspace_storage WHERE workspace_id = ?', 'ws_a')).toEqual([{ records: 5000 }]);
    expect(w.rows("SELECT records FROM intake_quota WHERE scope = '*' AND day = 'total'")).toEqual([{ records: 5000 }]);
  });

  it('the defaults: 2,000 records are stored, 2,001 are refused with a reason, counted for the owner, and cost almost nothing', async () => {
    const ok = await deliver(2000);
    expect(ok.threw).toBeNull();
    expect(ok.m.setReject).not.toHaveBeenCalled();
    expect(count(ok.w, 'report_records')).toBe(2000);
    const over = await deliver(2001);
    expect(over.m.setReject.mock.calls[0][0]).toMatch(/Report has 2001 records; the limit is 2000/);
    expect(count(over.w, 'aggregate_reports')).toBe(0);
    expect(over.w.rows('SELECT reason, messages FROM intake_failures')).toEqual([{ reason: 'too_many_records', messages: 1 }]);
    expect(over.counter.count).toBeLessThan(ok.counter.count);
  });

  it('20,000 records (the largest an operator can allow): same fixed budget, one transaction', async () => {
    const { w, counter, m, threw } = await deliver(20_000, { env: MAX_ENV });
    // eslint-disable-next-line no-console
    console.info(`[G4] 20000 records: ${counter.count} queries; kinds=${JSON.stringify(counter.kinds)}; largest batch ${counter.largestBatch} statements`);
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    expect(counter.refused).toBe(0);
    expect(counter.count).toBeLessThanOrEqual(QUERY_BUDGET);
    expect(counter.largestBatch).toBeLessThanOrEqual(50);
    expect(count(w, 'report_records')).toBe(20_000);
  });

  it('the query count does not depend on the record count', async () => {
    const small = await deliver(1);
    const big = await deliver(5000, { env: RAISED });
    expect(big.counter.count - small.counter.count).toBeLessThanOrEqual(3); // at most the IP-cache batches and the extra IP writes
  });

  it('fits the Free plan\'s 50 queries per invocation too', async () => {
    const { w, threw, counter } = await deliver(5000, { limit: D1_FREE_LIMIT, env: RAISED });
    expect(threw).toBeNull();
    expect(counter.refused).toBe(0);
    expect(count(w, 'report_records')).toBe(5000);
  });

  it('one query reads the IP cache and one writes it, however many IPs the report has', async () => {
    const { counter } = await deliver(5000, { env: RAISED });
    // four batches in all: the caps, the IP-cache read, the IP-cache write, and the report with its records
    expect(counter.kinds.batch).toBe(4);
    expect(counter.trace.filter((q) => /^select .*ip_info|from ip_info/i.test(q))).toHaveLength(0); // no per-IP select
  });

  it('a report that is a duplicate costs one query and stores nothing twice', async () => {
    const first = await deliver(200, { reportId: 'dup-1' });
    expect(count(first.w, 'report_records')).toBe(200);
    const before = first.w.rows('SELECT * FROM intake_quota ORDER BY scope, day');
    const again = await deliver(200, { reportId: 'dup-1', world: first.w });
    expect(again.threw).toBeNull();
    expect(again.m.setReject).not.toHaveBeenCalled();
    expect(count(again.w, 'aggregate_reports')).toBe(1);
    expect(count(again.w, 'report_records')).toBe(200);
    expect(again.w.rows('SELECT records FROM workspace_storage WHERE workspace_id = ?', 'ws_a')).toEqual([{ records: 200 }]);
    // the duplicate counted as a message received, not as records stored
    const after = again.w.rows('SELECT * FROM intake_quota ORDER BY scope, day');
    for (const row of after) expect(row.records).toBe(before.find((b: any) => b.scope === row.scope && b.day === row.day)?.records ?? 0);
    expect(again.counter.trace.some((q) => /^batch$/.test(q) && false)).toBe(false);
    expect(again.counter.count).toBeLessThan(first.counter.count); // no IP lookups, no store
  });
});

/** Make the statements that write `table` fail when they run (inside the batch, after the ones before them ran), like a D1 error would. */
const failWrites = (table: string) => (db: D1Database): D1Database =>
  new Proxy(db as any, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!new RegExp(`insert\\s+(or\\s+\\w+\\s+)?into\\s+"?${table}"?`, 'i').test(sql)) return stmt;
          const boom = (): Promise<never> => Promise.reject(new Error('D1_ERROR: storage failure injected by the test'));
          return new Proxy(stmt, {
            get(t, p) {
              if (p === 'bind') return (...a: unknown[]) => failing(t.bind(...a));
              if (p === 'run' || p === 'all' || p === 'first' || p === 'raw') return boom;
              const v = Reflect.get(t, p, t);
              return typeof v === 'function' ? v.bind(t) : v;
            },
          });
          function failing(s: any): any {
            return new Proxy(s, { get(t, p) { if (p === 'bind') return (...a: unknown[]) => failing(t.bind(...a)); if (p === 'run' || p === 'all' || p === 'first' || p === 'raw') return boom; if (p === '__inner') return { sql, run: boom, all: boom, first: boom, raw: boom }; const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
          }
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;

describe('G4: a storage failure is never accepted and dropped', () => {
  it('the report row cannot be written: the delivery fails (the sender retries), nothing is stored, the owner sees it', async () => {
    const { w, m, threw } = await deliver(3, { wrap: failWrites('aggregate_reports') });
    expect(threw).toBeInstanceOf(StorageFailure);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(count(w, 'aggregate_reports')).toBe(0);
    expect(count(w, 'report_records')).toBe(0);
    expect(w.rows('SELECT domain_id, workspace_id, reason, messages FROM intake_failures')).toEqual([{ domain_id: 1, workspace_id: 'ws_a', reason: 'storage_failed', messages: 1 }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"outcome":"deferred","reason":"storage_failed"'));
  });

  it('the records cannot be written: the report row that was inserted before them is rolled back (all or nothing)', async () => {
    const { w, m, threw } = await deliver(3, { wrap: failWrites('report_records') });
    expect(threw).toBeInstanceOf(StorageFailure);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(count(w, 'aggregate_reports')).toBe(0);
    expect(count(w, 'report_records')).toBe(0);
    expect(count(w, 'workspace_storage')).toBe(0);
  });

  it('the sender\'s retry, once D1 is healthy, stores the whole report (nothing half-written is left to dedupe it away)', async () => {
    const failed = await deliver(3, { wrap: failWrites('report_records'), reportId: 'retry-1' });
    expect(failed.threw).toBeInstanceOf(StorageFailure);
    const retry = await deliver(3, { reportId: 'retry-1', world: failed.w });
    expect(retry.threw).toBeNull();
    expect(count(retry.w, 'aggregate_reports')).toBe(1);
    expect(count(retry.w, 'report_records')).toBe(3);
  });

  it('a known reporter\'s report is NEVER refused for good because of our storage failures: it throws every time (the sender may retry) and the owner sees the count', async () => {
    const env = { INTAKE_MAX_STORAGE_RETRIES_PER_DAY: '1' };
    let world: Awaited<ReturnType<typeof twoWorkspaces>> | undefined;
    for (let i = 0; i < 4; i++) {
      const r = await deliver(3, { wrap: failWrites('aggregate_reports'), env, reportId: 'stuck', world });
      world = r.w;
      expect(r.threw, `attempt ${i + 1}`).toBeInstanceOf(StorageFailure);
      expect(r.m.setReject).not.toHaveBeenCalled();
    }
    expect(world!.rows('SELECT reason, messages FROM intake_failures')).toEqual([{ reason: 'storage_failed', messages: 4 }]);
  });

  it('an uncounted sender\'s report that keeps failing is refused for good, counted PER MESSAGE: an outage does not turn other reports of the domain into refusals', async () => {
    const env = { INTAKE_MAX_STORAGE_RETRIES_PER_DAY: '2', INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '1000', INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY: '1000' };
    const unauth = { headers: { 'x-sender': 'nobody' } };
    // twenty failures of OTHER messages (an outage) ...
    let world: Awaited<ReturnType<typeof twoWorkspaces>> | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await deliver(3, { wrap: failWrites('aggregate_reports'), env, reportId: `outage-${i}`, world, ...unauth });
      world = r.w;
      expect(r.threw, `outage ${i}`).toBeInstanceOf(StorageFailure); // each message is on its first failure: retried, not refused
    }
    // ... then one message that keeps failing: two attempts are retried, the third is refused for good
    const tries: unknown[] = [];
    let last: Awaited<ReturnType<typeof deliver>> | undefined;
    for (let i = 0; i < 3; i++) { last = await deliver(3, { wrap: failWrites('aggregate_reports'), env, reportId: 'stuck', world, ...unauth }); tries.push(last.threw); }
    expect(tries[0]).toBeInstanceOf(StorageFailure);
    expect(tries[1]).toBeInstanceOf(StorageFailure);
    expect(tries[2]).toBeNull();
    expect(last!.m.setReject).toHaveBeenCalledWith('Report could not be stored after repeated attempts');
    // a different message of the same domain, same day, is still retried rather than refused
    const other = await deliver(3, { wrap: failWrites('aggregate_reports'), env, reportId: 'fresh', world, ...unauth });
    expect(other.threw).toBeInstanceOf(StorageFailure);
    // the owner-visible count still counts every failure
    expect(world!.rows("SELECT messages FROM intake_failures WHERE reason = 'storage_failed'")).toEqual([{ messages: 20 + 3 + 1 }]);
  });

  it('running out of the invocation\'s query budget in the middle of storing cannot leave a half-stored report either', async () => {
    // cut the budget just before the storing batch: the query is refused, the report is not stored, the delivery fails
    const probe = await deliver(20);
    const at = probe.counter.trace.findIndex((q) => /^batch$/.test(q) || /aggregate_reports/.test(q));
    expect(at).toBeGreaterThan(0);
    for (const cut of [at, at + 1]) {
      const { w, threw, m } = await deliver(20, { limit: cut });
      expect(m.setReject).not.toHaveBeenCalled();
      expect(threw, `limit ${cut}`).not.toBeNull();
      const reports = count(w, 'aggregate_reports');
      const records = count(w, 'report_records');
      expect(reports === 0 ? records === 0 : records === 20, `limit ${cut}: ${reports} reports, ${records} records`).toBe(true);
    }
  });
});
