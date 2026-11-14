// G4 reproduction: what the hosted intake does today with a large report and with a storage failure.
//
// Local D1 does not enforce Cloudflare's "1000 queries per Worker invocation" (50 on Free), so the binding is wrapped in
// test/helpers/counting-d1.ts, which counts the way Cloudflare does (prepare().first/all/run/raw = 1 each, batch() = 1)
// and refuses every query past the limit.
//
// Naming convention for phase 2:
//   `TODAY: …`     pins the CURRENT (wrong) behaviour. These tests are expected to fail once G4 is fixed; the fix flips them.
//   `it.fails(…)`  states the REQUIRED behaviour and fails today. Remove `.fails` when G4 lands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@inbox-angel/db';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { fakeMessage, gzipReportMime } from '../helpers/mail';
import { reportWithDistinctIps } from '../helpers/big-report';
import { countingD1 } from '../helpers/counting-d1';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.inboxangel.io';
const D1_PAID_LIMIT = 1000;
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Deliver one message through the real email() export, with `env.DB` replaced by a counting binding. */
async function deliver(n: number, wrap: (db: D1Database) => D1Database = (d) => d, limit = D1_PAID_LIMIT) {
  resetSchemaReadyCache(); // the schema check (1 query) runs on a cold isolate, so it is part of the invocation
  const w = await twoWorkspaces();
  const counter = countingD1(w.db as unknown as D1Database, limit);
  const env = { ...w.env, DB: wrap(counter.db) } as any;
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(reportWithDistinctIps('a-corp.com', `big-${n}`, n)), GOOGLE);
  counter.reset(limit); // seeding is not part of the invocation
  let threw: unknown = null;
  await worker.email(m, env, ctx).catch((e: unknown) => { threw = e; });
  return { w, counter, m, threw };
}

describe('G4 repro: 5,000 distinct-IP records through email() in hosted mode', () => {
  it('TODAY: the invocation needs more than 1,000 D1 queries; the report is not stored and the delivery fails deterministically (the sender retries until it gives up)', async () => {
    const { w, counter, m, threw } = await deliver(5000);
    // eslint-disable-next-line no-console
    console.info(`[G4 repro] 5000 records: ${counter.count} queries attempted, ${counter.refused} refused past ${D1_PAID_LIMIT}; kinds=${JSON.stringify(counter.kinds)}; batches=${counter.kinds.batch ?? 0} (largest ${counter.largestBatch} statements)`);
    expect(counter.count).toBeGreaterThan(D1_PAID_LIMIT);
    expect(counter.refused).toBeGreaterThan(0);
    // Records past the budget are skipped (Skipping unparseable record), then the domain lookup itself is refused. That one is not
    // inside the storeReport try/catch, so email() throws: a temporary failure for the sender, which will meet the same wall on every retry.
    expect(String((threw as any)?.cause ?? threw)).toMatch(/Exceeded the maximum number of queries/);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(0);
  });

  it.fails('REQUIRED: stays within the D1 query budget and stores all 5,000 records, atomically', async () => {
    const { w, counter, m, threw } = await deliver(5000);
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    expect(counter.refused).toBe(0);
    expect(counter.count).toBeLessThan(D1_PAID_LIMIT / 2); // "well under": phase 2 fixes the exact budget in docs/hosted.md
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(1);
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(5000);
  });

  it('a small report (1 record) is cheap and works today: the baseline count', async () => {
    const { w, counter, m, threw } = await deliver(1);
    // eslint-disable-next-line no-console
    console.info(`[G4 repro] 1 record: ${counter.count} queries; kinds=${JSON.stringify(counter.kinds)}`);
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(1);
  });
});

/** Make every statement that writes `table` fail, the way a D1 outage or an exceeded limit would. */
const failWrites = (table: string) => (db: D1Database): D1Database =>
  new Proxy(db as any, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (new RegExp(`insert\\s+(or\\s+\\w+\\s+)?into\\s+"?${table}"?`, 'i').test(sql)) {
            const boom = () => Promise.reject(new Error('D1_ERROR: storage failure injected by the test'));
            const stmt: any = { bind: () => stmt, run: boom, all: boom, first: boom, raw: boom };
            return stmt;
          }
          return target.prepare(sql);
        };
      }
      if (prop === 'batch') {
        return (stmts: any[]) =>
          stmts.some((s) => s.__inner === undefined && s.run && s.run.name === 'boom') ? Promise.reject(new Error('D1_ERROR: storage failure injected by the test')) : target.batch(stmts);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;

describe('G4 repro: a storage failure after the mail was parsed', () => {
  it('TODAY: the aggregate row cannot be written, the error is swallowed, the mail is accepted and nothing is stored', async () => {
    const { w, m, threw } = await deliver(3, failWrites('aggregate_reports'));
    expect(threw).toBeNull();                        // no retry
    expect(m.setReject).not.toHaveBeenCalled();      // no refusal either: the sender believes it was delivered
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(0);
    expect(console.error).toHaveBeenCalledWith('dmarc-report: D1 storage failed for', 'a-corp.com', expect.any(Error));
  });

  it.fails('REQUIRED: a report that could not be stored makes the delivery fail (retry) or leaves a marker the owner can see', async () => {
    const { w, m, threw } = await deliver(3, failWrites('aggregate_reports'));
    const retried = threw !== null;
    const refused = m.setReject.mock.calls.length > 0;
    expect(retried || refused).toBe(true); // phase 2: throw so the sender retries; the marker is asserted in the G4 tests
    void w;
  });

  it('TODAY: the report row is written but its records are not; the report then looks like "0 messages", and a redelivery is skipped as a duplicate', async () => {
    const { w, m, threw } = await deliver(3, failWrites('report_records'));
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    const [row] = w.rows('SELECT report_id, total_count, pass_count FROM aggregate_reports');
    expect(row).toEqual({ report_id: 'big-3', total_count: 1 + 2 + 3, pass_count: expect.any(Number) }); // totals say 6 messages ...
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(0);                             // ... with no records behind them

    // Redelivery of the same report once D1 is healthy again: INSERT OR IGNORE sees the half-written row and skips it for good.
    resetSchemaReadyCache();
    const again = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(reportWithDistinctIps('a-corp.com', 'big-3', 3)), GOOGLE);
    await worker.email(again, { ...w.env } as any, ctx);
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(0); // still no records: the retry could not repair it
  });

  it.fails('REQUIRED: storing one report is all-or-nothing (no report row without its records)', async () => {
    const { w } = await deliver(3, failWrites('report_records'));
    const reports = w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n;
    const records = w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n;
    expect(reports === 0 || records === 3).toBe(true);
  });
});

describe('G4 repro: the budget runs out exactly while the report is being stored (no injected failure)', () => {
  // Calibrate on a small report: find where insertAggregate and insertRecords (one batch) sit in its query trace, then cut the budget
  // exactly before each of them, as a report of ~940 records does on today's code (measured against this code: 941 records → the
  // records insert is refused; 942 → the report insert is refused; 943+ → the domain lookup is refused and email() throws).
  const N = 20;
  const positionOf = async (needle: RegExp) => {
    const full = await deliver(N);
    await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget first-report mail finish its queries
    return full.counter.trace.findIndex((q) => needle.test(q)); // 0-based: a budget of this many queries refuses exactly that one
  };

  it('TODAY: budget gone at the records insert: the report row exists with its totals but no records, mail accepted', async () => {
    const at = await positionOf(/^batch$/);
    const { w, m, threw, counter } = await deliver(N, (d) => d, at);
    expect(counter.refused).toBeGreaterThan(0);
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(1);
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(0);
    expect(w.rows('SELECT total_count FROM aggregate_reports')[0].total_count).toBeGreaterThan(0);
  });

  it('TODAY: budget gone at the report insert: storeReport fails, the error is logged and swallowed, mail accepted, nothing stored', async () => {
    const at = await positionOf(/^insert into "aggregate_reports"/);
    const { w, m, threw, counter } = await deliver(N, (d) => d, at);
    expect(counter.refused).toBeGreaterThan(0);
    expect(threw).toBeNull();
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(0);
    expect(console.error).toHaveBeenCalledWith('dmarc-report: D1 storage failed for', 'a-corp.com', expect.any(Error));
  });
});
