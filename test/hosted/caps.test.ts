// G6: caps on messages and stored records per address, workspace and instance; what happens over a cap; the visible state; the
// retention sweep of the counters. Over-cap mail is refused for good (5xx in the SMTP session: no backscatter, and a retry the same
// day cannot succeed), counted for the owner, and costs a bounded number of queries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forWorkspace, resetSchemaReadyCache, lifecycleQueries, sweepLimits } from '@ready-set-mail/db';

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
const RUA = 'rua.readysetmail.com';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
// An authenticated sender that is not in the registry (tier unknown): over a cap it is refused with a 5xx. A registry reporter (GOOGLE) over a cap is accepted and dropped.
const OTHER = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=other.example header.s=s1' }, from: 'noreply-dmarc-support@other.example' };
/** The MIME's From header is Google's; an "other.example" message needs its own From header to be authenticated (DKIM organisation = From organisation). */
const mimeFor = (xml: string, from?: string) => (from?.endsWith('@other.example') ? gzipReportMime(xml).replace('From: noreply-dmarc-support@google.com', `From: ${from}`) : gzipReportMime(xml));
const otherReport = (domain: string, id: string, n: number) => reportWithDistinctIps(domain, id, n).replaceAll('google.com', 'other.example');
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type World = Awaited<ReturnType<typeof twoWorkspaces>>;
async function send(w: World, xml: string, o: { token?: string; env?: Record<string, string>; from?: string; headers?: Record<string, string> } = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(`rua+${o.token ?? w.tokenA}@${RUA}`, mimeFor(xml, o.from), { headers: o.headers ?? GOOGLE.headers, ...(o.from ? { from: o.from } : {}) });
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
  it('uncounted mail: the next message is refused for good (own per-address total), nothing is stored, other addresses and the counted address cap are unaffected', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY: '2', INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '2' });
    for (const id of ['r1', 'r2']) expect((await send(w, dmarcXml('a-corp.com', id, 'other.example'), OTHER)).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'r3', 'other.example'), OTHER);
    expect(over.setReject).toHaveBeenCalledWith('Daily intake limit for reports from senders this service does not know reached; try again tomorrow');
    expect(rows(w, 'SELECT report_id FROM aggregate_reports ORDER BY id').map((r) => r.report_id)).toEqual(['other.example|r1', 'other.example|r2']);
    expect(failures(w)).toEqual([]); // a stranger's refused mail is not an owner-visible failure
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"outcome":"refused","reason":"cap_unknown_day"'));
    // uncounted mail never touched the counted per-address message counter
    expect(rows(w, "SELECT messages FROM intake_quota WHERE scope = 'a:1' AND day = ?", today())).toEqual([]);
    // the other workspace's address is not affected; the counted address cap (2) still has both slots for a known reporter
    expect((await send(w, dmarcXml('b-corp.org', 'rb'), { token: w.tokenB })).setReject).not.toHaveBeenCalled();
    for (const id of ['g1', 'g2']) expect((await send(w, dmarcXml('a-corp.com', id))).setReject).not.toHaveBeenCalled();
    expect(rows(w, "SELECT report_id FROM aggregate_reports WHERE reporter_tier = 'counted' AND domain_id = 1 ORDER BY id").map((r) => r.report_id)).toEqual(['google|g1', 'google|g2']);
  });

  it('a registry reporter over the cap is accepted and dropped (no 5xx), nothing is stored, the owner is told', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '2' });
    for (const id of ['r1', 'r2']) expect((await send(w, dmarcXml('a-corp.com', id))).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'r3'));
    expect(over.setReject).not.toHaveBeenCalled();
    expect(rows(w, 'SELECT report_id FROM aggregate_reports ORDER BY id').map((r) => r.report_id)).toEqual(['google|r1', 'google|r2']);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'over_cap_accepted_dropped', messages: 1 }]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"outcome":"accepted","reason":"over_cap_accepted_dropped"'));
  });

  it('a refused message gives its count back, so a flood of refusals cannot use up the address\'s allowance', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '1' });
    await send(w, dmarcXml('a-corp.com', 'u1'), { headers: {}, from: 'x@one.example' });
    for (let i = 0; i < 5; i++) expect((await send(w, dmarcXml('a-corp.com', 'u' + (i + 2)), { headers: {}, from: 'x@one.example' })).setReject).toHaveBeenCalled(); // per-sender bucket full
    // uncounted mail is charged to its own scopes (address total, workspace, instance), each given back for a refusal
    expect(rows(w, "SELECT scope, messages FROM intake_quota WHERE scope IN ('u:1', 'n:ws_a', 'n:*', 'a:1', '*') AND day = ? ORDER BY scope", today())).toEqual([{ scope: 'n:*', messages: 1 }, { scope: 'n:ws_a', messages: 1 }, { scope: 'u:1', messages: 1 }]);
  });
});

describe('unauthenticated mail per address per day, over every claimed sender', () => {
  it('a forger cannot multiply her allowance by claiming many sender domains; registry reporters are untouched', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY: '3', INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '10', INTAKE_MAX_UNAUTH_SENDERS_PER_DAY: '100' });
    for (let i = 0; i < 3; i++) expect((await send(w, dmarcXml('a-corp.com', 'f' + i), { headers: {}, from: `x@sender${i}.example` })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'f3'), { headers: {}, from: 'x@sender3.example' });
    expect(over.setReject).toHaveBeenCalledWith('Daily intake limit for this address reached; try again tomorrow');
    expect(over.setReject).toHaveBeenCalledOnce();
    expect(failures(w)).toEqual([]); // the unauthenticated-total cap is refused but not an owner-visible marker
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"outcome":"refused","reason":"cap_unauth_total_day"'));
    expect((await send(w, dmarcXml('a-corp.com', 'real', 'google.com'))).setReject).not.toHaveBeenCalled(); // registry: its own allowance
  });
});

describe('messages per workspace and per instance per day', () => {
  it('workspace: two addresses of one workspace share its cap; another workspace is unaffected (known reporter: accepted and dropped)', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY: '2' });
    const t2 = await secondAddress(w);
    expect((await send(w, dmarcXml('a-corp.com', 'w1'))).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a2-corp.com', 'w2'), { token: t2 })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'w3'));
    expect(over.setReject).not.toHaveBeenCalled();
    expect(n(w, 'aggregate_reports')).toBe(2);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'over_cap_accepted_dropped', messages: 1 }]);
    expect((await send(w, dmarcXml('b-corp.org', 'wb'), { token: w.tokenB })).setReject).not.toHaveBeenCalled();
  });

  it('uncounted workspace cap: its own, refused for good, and the counted workspace cap is untouched', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY: '2', INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY: '2' });
    const t2 = await secondAddress(w);
    expect((await send(w, dmarcXml('a-corp.com', 'w1', 'other.example'), OTHER)).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a2-corp.com', 'w2', 'other.example'), { ...OTHER, token: t2 })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'w3', 'other.example'), OTHER);
    expect(over.setReject).toHaveBeenCalledWith('Daily intake limit for reports from senders this service does not know reached for this account; try again tomorrow');
    expect(failures(w)).toEqual([]);
    expect((await send(w, dmarcXml('b-corp.org', 'wb', 'other.example'), { ...OTHER, token: w.tokenB })).setReject).not.toHaveBeenCalled();
    for (const id of ['g1', 'g2']) expect((await send(w, dmarcXml('a-corp.com', id))).setReject).not.toHaveBeenCalled(); // counted workspace cap: both slots free
    expect(rows(w, "SELECT COUNT(*) AS n FROM aggregate_reports WHERE reporter_tier = 'counted'")).toEqual([{ n: 2 }]);
  });

  it('instance: one tenant cannot use the whole day\'s capacity of the shared service', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY: '2' });
    expect((await send(w, dmarcXml('a-corp.com', 'i1'))).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('b-corp.org', 'i2'), { token: w.tokenB })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'i3'));
    expect(over.setReject).not.toHaveBeenCalled(); // a known reporter is accepted and dropped
    expect(n(w, 'aggregate_reports')).toBe(2);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'over_cap_accepted_dropped', messages: 1 }]);
  });

  it('uncounted instance cap: its own, refused for good', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNCOUNTED_INSTANCE_MESSAGES_PER_DAY: '2' });
    expect((await send(w, dmarcXml('a-corp.com', 'i1', 'other.example'), OTHER)).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('b-corp.org', 'i2', 'other.example'), { ...OTHER, token: w.tokenB })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'i3', 'other.example'), OTHER);
    expect(over.setReject).toHaveBeenCalledWith('The service is receiving more reports from unknown senders than it can take today; try again tomorrow');
    expect(failures(w)).toEqual([]);
  });
});

describe('stored records: per address per day, per workspace, per instance', () => {
  it('uncounted workspace storage: once it holds its (own) cap, newer uncounted reports are refused and not stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNCOUNTED_WORKSPACE_RECORDS: '5' });
    expect((await send(w, otherReport('a-corp.com', 's1', 3), OTHER)).setReject).not.toHaveBeenCalled();
    const over = await send(w, otherReport('a-corp.com', 's2', 3), OTHER); // 3 + 3 > 5
    expect(over.setReject).toHaveBeenCalledWith('Storage limit for reports from senders this service does not know reached for this account');
    expect(rows(w, 'SELECT report_id FROM aggregate_reports').map((r) => r.report_id)).toEqual(['other.example|s1']);
    expect(n(w, 'report_records')).toBe(3);
    expect(failures(w)).toEqual([]);
    expect(rows(w, "SELECT records, uncounted_records FROM workspace_storage WHERE workspace_id = 'ws_a'")).toEqual([{ records: 0, uncounted_records: 3 }]);
    expect((await send(w, otherReport('b-corp.org', 'sb', 3), { ...OTHER, token: w.tokenB })).setReject).not.toHaveBeenCalled(); // another workspace
    // a small report that still fits is accepted
    expect((await send(w, otherReport('a-corp.com', 's3', 2), OTHER)).setReject).not.toHaveBeenCalled();
  });

  it('counted workspace storage: a known reporter over the cap is accepted and dropped, loudly (see counted-drop tests)', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_RECORDS: '5' });
    expect((await send(w, reportWithDistinctIps('a-corp.com', 's1', 3))).setReject).not.toHaveBeenCalled();
    const over = await send(w, reportWithDistinctIps('a-corp.com', 's2', 3)); // 3 + 3 > 5
    expect(over.setReject).not.toHaveBeenCalled();
    expect(rows(w, 'SELECT report_id FROM aggregate_reports').map((r) => r.report_id)).toEqual(['google|s1']);
    expect(n(w, 'report_records')).toBe(3);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'over_cap_accepted_dropped', messages: 1 }]);
    expect((await send(w, reportWithDistinctIps('b-corp.org', 'sb', 3), { token: w.tokenB })).setReject).not.toHaveBeenCalled(); // another workspace
    expect((await send(w, reportWithDistinctIps('a-corp.com', 's3', 2))).setReject).not.toHaveBeenCalled(); // a small report that still fits
  });

  it('visible: the dashboard fields read "Report storage limit reached; newer reports are not being stored"', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_RECORDS: '3' });
    await send(w, reportWithDistinctIps('a-corp.com', 's1', 3));
    const tenant = makeTenant({ db: w.db, workspaceId: 'ws_a', env: { ...w.env, INTAKE_MAX_WORKSPACE_RECORDS: '3' } as any, mode: 'saas' });
    const v = await reportVisibility(tenant, 1, 0);
    expect(v.intake).toMatchObject({ status: 'limited', limit: 'workspace_storage', notice: 'Report storage limit reached; newer reports are not being stored' });
  });

  it('instance: counted across workspaces (known reporter: accepted and dropped); uncounted has its own instance budget', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_INSTANCE_RECORDS: '5', INTAKE_MAX_UNCOUNTED_INSTANCE_RECORDS: '5' });
    await send(w, reportWithDistinctIps('a-corp.com', 'a1', 3));
    const over = await send(w, reportWithDistinctIps('b-corp.org', 'b1', 3), { token: w.tokenB });
    expect(over.setReject).not.toHaveBeenCalled();
    expect(n(w, 'aggregate_reports')).toBe(1);
    expect(failures(w)).toEqual([{ domain_id: 2, reason: 'over_cap_accepted_dropped', messages: 1 }]);
    // uncounted: 3 fit (own budget, the counted one is full), the next 3 do not
    expect((await send(w, otherReport('a-corp.com', 'u1', 3), OTHER)).setReject).not.toHaveBeenCalled();
    const unc = await send(w, otherReport('b-corp.org', 'u2', 3), { ...OTHER, token: w.tokenB });
    expect(unc.setReject).toHaveBeenCalledWith('The service has reached its storage limit for reports from unknown senders');
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = '*u' AND day = 'total'")).toEqual([{ records: 3 }]);
    expect(rows(w, "SELECT records FROM intake_quota WHERE scope = '*' AND day = 'total'")).toEqual([{ records: 3 }]);
  });

  it('address per day: stored records, not messages; counted and uncounted have separate counters', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY: '4', INTAKE_MAX_ADDRESS_RECORDS_PER_DAY: '4' });
    await send(w, otherReport('a-corp.com', 'd1', 3), OTHER);
    const over = await send(w, otherReport('a-corp.com', 'd2', 3), OTHER);
    expect(over.setReject).toHaveBeenCalledWith('Daily record limit for reports from senders this service does not know reached for this address; try again tomorrow');
    expect(rows(w, "SELECT scope, records FROM intake_quota WHERE scope IN ('a:1', 'ua:1') AND day = ?", today())).toEqual([{ scope: 'ua:1', records: 3 }]);
    expect((await send(w, reportWithDistinctIps('a-corp.com', 'g1', 3))).setReject).not.toHaveBeenCalled(); // the counted address budget is untouched
    expect(rows(w, "SELECT scope, records FROM intake_quota WHERE scope IN ('a:1', 'ua:1') AND day = ? ORDER BY scope", today())).toEqual([{ scope: 'a:1', records: 3 }, { scope: 'ua:1', records: 3 }]);
  });

  it('a registry reporter over a storage cap is accepted and dropped: not stored, the owner is told', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_WORKSPACE_RECORDS: '5' });
    expect((await send(w, reportWithDistinctIps('a-corp.com', 's1', 3))).setReject).not.toHaveBeenCalled();
    const over = await send(w, reportWithDistinctIps('a-corp.com', 's2', 3)); // 3 + 3 > 5
    expect(over.setReject).not.toHaveBeenCalled();
    expect(rows(w, 'SELECT report_id FROM aggregate_reports').map((r) => r.report_id)).toEqual(['google|s1']);
    expect(failures(w)).toEqual([{ domain_id: 1, reason: 'over_cap_accepted_dropped', messages: 1 }]);
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

describe('thousands of tiny messages: the caps hold and each over-cap message is cheap', () => {
  // A registry reporter (Google) is accepted-and-dropped over the cap; any other sender is refused with a 5xx. Both cost a bounded number of queries.
  for (const [name, sender, dropped] of [['registry reporter: 20 stored, the rest accepted and dropped', GOOGLE, true], ['non-registry sender: 20 stored, the rest refused', OTHER, false]] as const) {
    it(`500 messages to one address with a cap of 20, ${name}`, async () => {
      const w = await twoWorkspaces({ INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '20', INTAKE_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY: '1000', INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY: dropped ? '1000' : '20', INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY: '1000', INTAKE_MAX_UNCOUNTED_INSTANCE_MESSAGES_PER_DAY: '1000' });
      const counter = countingD1(w.db as any, 1_000_000);
      const env = { ...w.env, DB: counter.db } as any;
      let stored = 0;
      let rejected = 0;
      let worstOver = 0;
      for (let i = 0; i < 500; i++) {
        resetSchemaReadyCache();
        const org = dropped ? 'google.com' : 'other.example';
        const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, mimeFor(dmarcXml('a-corp.com', 'tiny' + i, org), dropped ? undefined : OTHER.from), { headers: sender.headers, ...('from' in sender ? { from: sender.from } : {}) });
        counter.reset(1_000_000);
        await worker.email(m, env, ctx);
        if (m.setReject.mock.calls.length) rejected++;
        if (i >= 20) worstOver = Math.max(worstOver, counter.count);
      }
      stored = n(w, 'aggregate_reports');
      expect(stored).toBe(20);
      expect(rejected).toBe(dropped ? 0 : 480);
      expect(worstOver).toBeLessThanOrEqual(12); // schema check, token, two consume batches, marker...
      // one row, a counter: a flood cannot grow it. (A stranger's refusal is not an owner-visible failure; its per-address total holds at the cap.)
      if (dropped) expect(rows(w, 'SELECT messages FROM intake_failures WHERE reason = ?', 'over_cap_accepted_dropped')).toEqual([{ messages: 480 }]);
      else expect(rows(w, "SELECT messages FROM intake_quota WHERE scope = 'k:1' AND day = ?", today())).toEqual([{ messages: 20 }]);
    }, 60_000);
  }
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
    expect(rows(w, "SELECT scope FROM intake_quota WHERE day = 'total' ORDER BY scope")).toEqual([{ scope: '*' }, { scope: '*u' }]); // never matched by the day sweep (the recount may rewrite its value)
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
    w.db.sqlite.prepare("UPDATE aggregate_reports SET created_at = ?, date_end = ? WHERE report_id LIKE '%|old'").run(NOW - 400 * 86400, NOW - 400 * 86400);
    w.db.sqlite.prepare("UPDATE aggregate_reports SET created_at = ?, date_end = ? WHERE report_id LIKE '%|keep'").run(NOW - 86400, NOW - 86400); // the fixture's own dates are from 2018
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
