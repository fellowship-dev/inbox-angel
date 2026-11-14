// G6: caps on messages and stored records per address, workspace and instance; what happens over a cap; the visible state; the
// retention sweep of the counters. Over-cap mail is refused for good (5xx in the SMTP session: no backscatter, and a retry the same
// day cannot succeed), counted for the owner, and costs a bounded number of queries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forWorkspace, resetSchemaReadyCache, lifecycleQueries, sweepLimits } from '@inbox-angel/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { hashToken, generateToken } from '../../src/hosted/tokens';
import { reportVisibility } from '../../src/reports/visibility';
import { runRetention } from '../../src/lifecycle/retention';
import { makeTenant } from '../helpers/tenant';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { reportWithDistinctIps } from '../helpers/big-report';
import { countingD1 } from '../helpers/counting-d1';
import { nxdomain, quiet, twoWorkspaces, NOW } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.inboxangel.io';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type World = Awaited<ReturnType<typeof twoWorkspaces>>;
async function send(w: World, xml: string, o: { token?: string; env?: Record<string, string>; from?: string; headers?: Record<string, string> } = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(`rua+${o.token ?? w.tokenA}@${RUA}`, gzipReportMime(xml), { headers: o.headers ?? GOOGLE.headers, ...(o.from ? { from: o.from } : {}) });
  await worker.email(m, { ...w.env, ...(o.env ?? {}) } as any, ctx);
  return m;
}
const rows = (w: World, sql: string, ...p: unknown[]) => w.rows(sql, ...p);
const n = (w: World, table: string) => rows(w, `SELECT COUNT(*) AS n FROM ${table}`)[0].n as number;
const failures = (w: World) => rows(w, 'SELECT domain_id, reason, messages FROM intake_failures ORDER BY reason');

/** A second domain and token in workspace A, so a workspace cap can be hit through two addresses. */
async function secondAddress(w: World) {
  w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_a', 'a2-corp.com', 'x')").run();
  const token = generateToken();
  await forWorkspace(w.env.DB, 'ws_a').intake.set(3, await hashToken(token), NOW);
  return token;
}

describe('messages per address per day', () => {
  it('the next message is refused for good, nothing is stored, the owner is told, and other addresses are unaffected', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '2' });
    for (const id of ['r1', 'r2']) expect((await send(w, dmarcXml('a-corp.com', id))).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'r3'));
    expect(over.setReject).toHaveBeenCalledWith('Daily intake limit for this address reached; try again tomorrow');
    expect(rows(w, 'SELECT report_id FROM aggregate_reports ORDER BY id').map((r) => r.report_id)).toEqual(['r1', 'r2']);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'cap_address_day', messages: 1 }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"outcome":"refused","reason":"cap_address_day"'));
    // the other workspace's address is not affected
    expect((await send(w, dmarcXml('b-corp.org', 'rb'), { token: w.tokenB })).setReject).not.toHaveBeenCalled();
  });

  it('a refused message gives its count back, so a flood of refusals cannot use up the address\'s allowance', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '1' });
    await send(w, dmarcXml('a-corp.com', 'u1'), { headers: {}, from: 'x@one.example' });
    for (let i = 0; i < 5; i++) expect((await send(w, dmarcXml('a-corp.com', 'u' + (i + 2)), { headers: {}, from: 'x@one.example' })).setReject).toHaveBeenCalled(); // per-sender bucket full
    expect(rows(w, "SELECT messages FROM intake_quota WHERE scope = 'a:1' AND day = ?", today())).toEqual([{ messages: 1 }]);
    expect(rows(w, "SELECT messages FROM intake_quota WHERE scope = '*' AND day = ?", today())).toEqual([{ messages: 1 }]);
  });
});

describe('unproven mail per address per day, over every claimed sender', () => {
  it('a forger cannot multiply her allowance by claiming many sender domains; proven reporters are untouched', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY: '3', INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '10', INTAKE_MAX_UNAUTH_SENDERS_PER_DAY: '100' });
    for (let i = 0; i < 3; i++) expect((await send(w, dmarcXml('a-corp.com', 'f' + i), { headers: {}, from: `x@sender${i}.example` })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'f3'), { headers: {}, from: 'x@sender3.example' });
    expect(over.setReject).toHaveBeenCalledWith('Daily intake limit for this address reached; try again tomorrow');
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'cap_unauth_day', messages: 1 }]);
    expect((await send(w, dmarcXml('a-corp.com', 'real', 'google.com'))).setReject).not.toHaveBeenCalled(); // proven: its own allowance
  });
});

describe('messages per workspace and per instance per day', () => {
  it('workspace: two addresses of one workspace share its cap; another workspace is unaffected', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY: '2' });
    const t2 = await secondAddress(w);
    expect((await send(w, dmarcXml('a-corp.com', 'w1'))).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a2-corp.com', 'w2'), { token: t2 })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'w3'));
    expect(over.setReject).toHaveBeenCalledWith('Daily intake limit for this account reached; try again tomorrow');
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'cap_workspace_day', messages: 1 }]);
    expect((await send(w, dmarcXml('b-corp.org', 'wb'), { token: w.tokenB })).setReject).not.toHaveBeenCalled();
  });

  it('instance: one tenant cannot use the whole day\'s capacity of the shared service', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY: '2' });
    expect((await send(w, dmarcXml('a-corp.com', 'i1'))).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('b-corp.org', 'i2'), { token: w.tokenB })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'i3'));
    expect(over.setReject).toHaveBeenCalledWith('The service is receiving more reports than it can take today; try again tomorrow');
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'cap_instance_day', messages: 1 }]);
  });
});

describe('stored records: per address per day, per workspace, per instance', () => {
  it('workspace: once it holds its cap, newer reports are refused and not stored; the state says so', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_RECORDS: '5' });
    expect((await send(w, reportWithDistinctIps('a-corp.com', 's1', 3))).setReject).not.toHaveBeenCalled();
    const over = await send(w, reportWithDistinctIps('a-corp.com', 's2', 3)); // 3 + 3 > 5
    expect(over.setReject).toHaveBeenCalledWith('Report storage limit for this account reached');
    expect(rows(w, 'SELECT report_id FROM aggregate_reports').map((r) => r.report_id)).toEqual(['s1']);
    expect(n(w, 'report_records')).toBe(3);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'cap_workspace_storage', messages: 1 }]);
    expect((await send(w, reportWithDistinctIps('b-corp.org', 'sb', 3), { token: w.tokenB })).setReject).not.toHaveBeenCalled(); // another workspace
    // a small report that still fits is accepted
    expect((await send(w, reportWithDistinctIps('a-corp.com', 's3', 2))).setReject).not.toHaveBeenCalled();
  });

  it('visible: the dashboard fields read "Report storage limit reached; newer reports are not being stored"', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_RECORDS: '3' });
    await send(w, reportWithDistinctIps('a-corp.com', 's1', 3));
    const tenant = makeTenant({ db: w.db, workspaceId: 'ws_a', env: { ...w.env, INTAKE_MAX_WORKSPACE_RECORDS: '3' } as any, mode: 'saas' });
    const v = await reportVisibility(tenant, 1, 0);
    expect(v.intake).toMatchObject({ status: 'limited', limit: 'workspace_storage', notice: 'Report storage limit reached; newer reports are not being stored' });
  });

  it('instance: counted across workspaces', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_INSTANCE_RECORDS: '5' });
    await send(w, reportWithDistinctIps('a-corp.com', 'a1', 3));
    const over = await send(w, reportWithDistinctIps('b-corp.org', 'b1', 3), { token: w.tokenB });
    expect(over.setReject).toHaveBeenCalledWith('The service has reached its report storage limit');
    expect(n(w, 'aggregate_reports')).toBe(1);
    expect(failures(w)).toEqual([{ domain_id: 2, reason: 'cap_instance_storage', messages: 1 }]);
  });

  it('address per day: stored records, not messages', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_ADDRESS_RECORDS_PER_DAY: '4' });
    await send(w, reportWithDistinctIps('a-corp.com', 'd1', 3));
    const over = await send(w, reportWithDistinctIps('a-corp.com', 'd2', 3));
    expect(over.setReject).toHaveBeenCalledWith('Daily report-record limit for this address reached; try again tomorrow');
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = 'a:1'")).toEqual([{ records: 3 }]);
  });

  it('a duplicate counts as a message received but adds no stored records, in any counter', async () => {
    const w = await twoWorkspaces();
    await send(w, reportWithDistinctIps('a-corp.com', 'dup', 4));
    await send(w, reportWithDistinctIps('a-corp.com', 'dup', 4));
    await send(w, reportWithDistinctIps('a-corp.com', 'dup', 4));
    expect(rows(w, 'SELECT records FROM workspace_storage')).toEqual([{ records: 4 }]);
    expect(rows(w, "SELECT scope, messages, records FROM intake_quota WHERE scope IN ('a:1', '*') AND day = ? ORDER BY scope", today())).toEqual([{ scope: '*', messages: 3, records: 0 }, { scope: 'a:1', messages: 3, records: 4 }]);
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = '*' AND day = 'total'")).toEqual([{ records: 4 }]); // stored records: once
    expect(n(w, 'report_records')).toBe(4);
  });
});

describe('a report that is too big for its sender\'s standing', () => {
  it('records per report: unproven mail gets a much smaller cap than a proven reporter', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT: '2', INTAKE_MAX_RECORDS_PER_REPORT: '10' });
    const unproven = await send(w, reportWithDistinctIps('a-corp.com', 'u', 3), { headers: {} });
    expect(unproven.setReject.mock.calls[0][0]).toMatch(/limit is 2/);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'too_many_records', messages: 1 }]);
    expect((await send(w, reportWithDistinctIps('a-corp.com', 'p', 3))).setReject).not.toHaveBeenCalled();
    expect((await send(w, reportWithDistinctIps('a-corp.com', 'big', 11))).setReject).toHaveBeenCalled();
  });
});

describe('thousands of tiny messages: the caps hold and each refusal is cheap', () => {
  it('500 messages to one address with a cap of 20: 20 accepted, the rest refused, bounded queries per message', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '20' });
    const counter = countingD1(w.db as any, 1_000_000);
    const env = { ...w.env, DB: counter.db } as any;
    let accepted = 0;
    let worstRefused = 0;
    for (let i = 0; i < 500; i++) {
      resetSchemaReadyCache();
      const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'tiny' + i)), GOOGLE);
      counter.reset(1_000_000);
      await worker.email(m, env, ctx);
      if (m.setReject.mock.calls.length === 0) accepted++; else worstRefused = Math.max(worstRefused, counter.count);
    }
    expect(accepted).toBe(20);
    expect(n(w, 'aggregate_reports')).toBe(20);
    expect(worstRefused).toBeLessThanOrEqual(12); // schema check, token, two consume batches, marker...
    expect(rows(w, "SELECT messages FROM intake_failures WHERE reason = 'cap_address_day'")).toEqual([{ messages: 480 }]); // one row, a counter: a flood cannot grow it
  }, 60_000);
});

describe('retention of the counters (the single 0 4 * * * cron), bounded per run', () => {
  const clock = () => NOW * 1000;
  const day = (ago: number) => new Date((NOW - ago * 86400) * 1000).toISOString().slice(0, 10);

  it('sweeps intake_usage, intake_quota and old failure markers; keeps today, yesterday, the stored-records total and recent failures', async () => {
    const w = await twoWorkspaces();
    const s = w.db.sqlite;
    for (const ago of [0, 1, 7, 9, 30]) {
      s.prepare("INSERT INTO intake_usage (domain_id, workspace_id, day, reporter, reports, bytes) VALUES (1, 'ws_a', ?, 'google.com', 1, 1)").run(day(ago));
      s.prepare("INSERT INTO intake_quota (scope, day, messages) VALUES ('a:1', ?, 1)").run(day(ago));
    }
    s.prepare("INSERT INTO intake_quota (scope, day, records) VALUES ('*', 'total', 7)").run();
    for (const ago of [1, 80, 100, 400]) s.prepare("INSERT INTO intake_failures (domain_id, workspace_id, day, reason, messages, last_at) VALUES (1, 'ws_a', ?, 'storage_failed', 1, 1)").run(day(ago));
    const r = await runRetention({ DB: w.env.DB } as any, { now: clock });
    expect(r.failed).toBe(0);
    expect(rows(w, "SELECT scope FROM intake_quota WHERE day = 'total'")).toEqual([{ scope: '*' }]); // never matched by the day sweep (the recount may rewrite its value)
    expect(rows(w, 'SELECT day FROM intake_usage ORDER BY day').map((x) => x.day)).toEqual([day(7), day(1), day(0)].sort());
    expect(rows(w, "SELECT day FROM intake_quota WHERE scope = 'a:1' ORDER BY day").map((x) => x.day)).toEqual([day(7), day(1), day(0)].sort());
    expect(rows(w, 'SELECT day FROM intake_failures ORDER BY day').map((x) => x.day)).toEqual([day(80), day(1)].sort());
    expect(r.intake_counters).toBe(4); // 2 usage + 2 quota rows older than 8 days
    expect(r.intake_failures).toBe(2);
    const again = await runRetention({ DB: w.env.DB } as any, { now: clock });
    expect(again.intake_counters).toBe(0);
  });

  it('the work per run is bounded: a big backlog takes several runs and says so', async () => {
    const w = await twoWorkspaces();
    const ins = w.db.sqlite.prepare("INSERT INTO intake_usage (domain_id, workspace_id, day, reporter) VALUES (1, 'ws_a', ?, ?)");
    for (let i = 0; i < 50; i++) ins.run(day(100), `r${i}.example`);
    // the shared statement budget is spent in order; give this run just enough to reach the counters and not to finish them
    const first = await runRetention({ DB: w.env.DB } as any, { now: clock, limits: { batch: 5, statements: 22 } });
    expect(first.intake_counters_truncated).toBe(true);
    expect(n(w, 'intake_usage')).toBeGreaterThan(0);
    expect(n(w, 'intake_usage')).toBeLessThan(50);
    for (let i = 0; i < 20 && n(w, 'intake_usage') > 0; i++) await runRetention({ DB: w.env.DB } as any, { now: clock, limits: { batch: 5, statements: 22 } });
    expect(n(w, 'intake_usage')).toBe(0);
  });

  it('purging reports gives their records back to the workspace and instance counters', async () => {
    const w = await twoWorkspaces();
    await send(w, reportWithDistinctIps('a-corp.com', 'old', 6));
    await send(w, reportWithDistinctIps('b-corp.org', 'keep', 2), { token: w.tokenB });
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = '*' AND day = 'total'")).toEqual([{ records: 8 }]);
    w.db.sqlite.prepare("UPDATE aggregate_reports SET created_at = ?, date_end = ? WHERE report_id = 'old'").run(NOW - 400 * 86400, NOW - 400 * 86400);
    w.db.sqlite.prepare("UPDATE aggregate_reports SET created_at = ?, date_end = ? WHERE report_id = 'keep'").run(NOW - 86400, NOW - 86400); // the fixture's own dates are from 2018
    await runRetention({ DB: w.env.DB } as any, { now: clock });
    expect(rows(w, 'SELECT workspace_id, records, reports FROM workspace_storage ORDER BY workspace_id').filter((r) => r.workspace_id !== 'ws_default')).toEqual([{ workspace_id: 'ws_a', records: 0, reports: 0 }, { workspace_id: 'ws_b', records: 2, reports: 1 }]);
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = '*' AND day = 'total'")).toEqual([{ records: 2 }]);
  });

  it('the daily recount repairs drift and counts data that was stored before the counters existed', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, workspace_id) VALUES (50, 1, 'old', 'legacy', ?, ?, 'ws_a')").run(NOW - 86400, NOW);
    for (let i = 0; i < 4; i++) w.db.sqlite.prepare("INSERT INTO report_records (report_id, source_ip, disposition, workspace_id) VALUES (50, ?, 'none', 'ws_a')").run(`10.0.0.${i}`);
    w.db.sqlite.prepare("INSERT INTO workspace_storage (workspace_id, records, reports) VALUES ('ws_b', 999, 999)").run(); // drift
    await runRetention({ DB: w.env.DB } as any, { now: clock });
    expect(rows(w, "SELECT workspace_id, records, reports FROM workspace_storage WHERE workspace_id IN ('ws_a', 'ws_b') ORDER BY workspace_id")).toEqual([{ workspace_id: 'ws_a', records: 4, reports: 1 }, { workspace_id: 'ws_b', records: 0, reports: 0 }]);
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = '*' AND day = 'total'")).toEqual([{ records: 4 }]);
    void lifecycleQueries; void sweepLimits; void today;
  });
});
