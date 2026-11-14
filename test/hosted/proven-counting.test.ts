// G5: a report counts toward the numbers only when its sender was proven. Every aggregate query, the analytics service the
// dashboard and agents share, the digest, and the "latest N" list are held to it. A forger with a public token must not move a
// pass rate, a failing-sender list, an anomaly, a level or "safe to enforce".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forWorkspace, resetSchemaReadyCache, type CountingMode } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { getAnalytics } from '../../src/reports/analytics';
import { getDomainReport } from '../../src/reports/service';
import { reportCounting } from '../../src/dmarc/counting';
import { buildDigestBody } from '../../src/digest/weekly';
import { makeTenant } from '../helpers/tenant';
import { nxdomain, quiet } from './world';

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// ── seeded data: a real report that fails, and a forged report that passes ──────────

function seed(db: ReturnType<typeof createMigratedD1>, ws = 'ws_default') {
  const s = db.sqlite;
  s.prepare("INSERT OR IGNORE INTO domains (id, domain, rua_address, workspace_id) VALUES (1, 'acme.com', 'x', ?)").run(ws);
  const report = (id: number, auth: string | null, total: number, pass: number, ip: string, begin: number, org = 'google.com', tier: string | null = auth === 'pass' ? 'counted' : null) => {
    s.prepare('INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id, reporter_auth, reporter_auth_domain, reporter_tier, reporter_identity) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, org, `r${id}`, begin, begin + DAY - 1, total, pass, total - pass, ws, auth, auth === 'pass' ? org : null, tier, tier === 'counted' ? org.split('.')[0] : tier === 'unknown' ? org : '~unauth');
    s.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, spf_result, header_from, workspace_id) VALUES (?, ?, ?, ?, ?, ?, 'acme.com', ?)")
      .run(id, ip, total, pass === total ? 'none' : 'reject', pass === total ? 'pass' : 'fail', pass === total ? 'pass' : 'fail', ws);
  };
  const begin = Math.floor((NOW - 2 * DAY) / DAY) * DAY;
  report(1, 'pass', 100, 50, '198.51.100.1', begin);                    // the real one: half of the mail fails
  report(2, 'pass', 1000, 1000, '203.0.113.7', begin, 'forger.example', 'unknown'); // an authenticated stranger: "100% pass"
  report(3, 'none', 500, 500, '203.0.113.8', begin, 'google.com', 'unauthenticated'); // claims google, not authenticated
  report(4, null, 200, 200, '203.0.113.9', begin, 'old.example', null); // stored before the columns existed
  return { begin };
}

const modes: CountingMode[] = ['registry', 'all'];

describe('every aggregate query counts only proven reports (and everything in `all` mode)', () => {
  it.each(modes)('%s: the daily totals, pass rate and day summary', async (mode) => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const since = begin - DAY;
    const stats = await q.reports.dailyStats(1, since);
    const total = stats.reduce((n, r) => n + r.total, 0);
    const passed = stats.reduce((n, r) => n + r.passed, 0);
    expect(mode === 'registry' ? { total, passed } : { total, passed }).toEqual(mode === 'registry' ? { total: 100, passed: 50 } : { total: 1800, passed: 1750 });
    const day = new Date(begin * 1000).toISOString().slice(0, 10);
    expect(await q.reports.daySummary(1, day)).toEqual(mode === 'registry' ? { total: 100, passed: 50, failed: 50 } : { total: 1800, passed: 1750, failed: 50 });
  });

  it.each(modes)('%s: failing sources, anomalies, all sources and sources by date list only counted senders', async (mode) => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const since = begin - DAY;
    const day = new Date(begin * 1000).toISOString().slice(0, 10);
    const ips = (rows: Array<{ source_ip: string }>) => rows.map((r) => r.source_ip).sort();
    const real = ['198.51.100.1'];
    const everything = ['198.51.100.1', '203.0.113.7', '203.0.113.8', '203.0.113.9'];
    expect(ips(await q.reports.allSources(1, since))).toEqual(mode === 'registry' ? real : everything);
    expect(ips(await q.reports.sourcesByDate(1, day))).toEqual(mode === 'registry' ? real : everything);
    expect(ips(await q.reports.anomalySources(1, since))).toEqual(real); // the forged ones pass, so only the real failure is an anomaly in both
    expect(ips(await q.reports.topFailingSources(1, since))).toEqual(real);
  });

  it('proven: a forged report full of failing mail does not appear in failing senders or anomalies either', async () => {
    const db = createMigratedD1();
    const s = db.sqlite;
    s.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'x')").run();
    const begin = Math.floor((NOW - 2 * DAY) / DAY) * DAY;
    s.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, reporter_auth) VALUES (9, 1, 'x', 'bad', ?, ?, 9999, 0, 9999, 'none')").run(begin, begin + DAY - 1);
    s.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, spf_result, header_from) VALUES (9, '192.0.2.99', 9999, 'reject', 'fail', 'fail', 'acme.com')").run();
    const q = forWorkspace(db, 'ws_default', { counting: 'registry' });
    expect(await q.reports.topFailingSources(1, begin - DAY)).toEqual([]);
    expect(await q.reports.anomalySources(1, begin - DAY)).toEqual([]);
  });

  it.each(modes)('%s: weekly digest stats, check summary (levels), evidence and the first-report count', async (mode) => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const since = begin - DAY;
    const [w] = await q.reports.weeklyDomainStats(since);
    expect({ total: w.total_messages, reports: w.report_count, uncounted: w.uncounted_reports }).toEqual(mode === 'registry' ? { total: 100, reports: 1, uncounted: 3 } : { total: 1800, reports: 4, uncounted: 0 });
    const cs = (await q.reports.checkSummary(1, since))!;
    expect(cs.total_messages).toBe(mode === 'registry' ? 100 : 1800);
    expect(cs.dkim_total).toBe(mode === 'registry' ? 100 : 1800);
    const ev = await q.reports.evidence(1, since, NOW);
    expect(ev.dmarc.report_count).toBe(mode === 'registry' ? 1 : 4);
    expect(ev.dmarc.observations.map((o) => o.source_report_id).sort()).toEqual(mode === 'registry' ? ['r1'] : ['r1', 'r2', 'r3', 'r4']);
    expect(await q.reports.countForDomain(1)).toBe(mode === 'registry' ? 1 : 4);
    const exported = await q.reports.exportData(1);
    expect(exported.filter((r) => r.counted).length).toBe(mode === 'registry' ? 1 : 4); // every row is there, labelled
    expect(exported.length).toBe(4);
  });

  it.each(modes)('%s: analytics (trend, sender inventory, readiness inputs, workspace totals)', async (mode) => {
    const db = createMigratedD1();
    seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const now = NOW;
    const rows = await q.analytics.senderRows(null, now - 30 * DAY, now - 30 * DAY, now);
    expect(rows.map((r) => r.source_ip).sort()).toEqual(mode === 'registry' ? ['198.51.100.1'] : ['198.51.100.1', '203.0.113.7', '203.0.113.8', '203.0.113.9']);
    const trend = await q.analytics.trend(null, now - 30 * DAY, now);
    expect(trend.reduce((n, r) => n + r.total, 0)).toBe(mode === 'registry' ? 100 : 1800);
    const totals = await q.analytics.domainTotals(now - 30 * DAY, now);
    expect(totals[0].total).toBe(mode === 'registry' ? 100 : 1800);
    expect(await q.analytics.earliestReport(null, now)).not.toBeNull();
  });

  it('the shared service the dashboard and MCP use: pass rate and "safe to enforce" ignore forged reports, and say what was left out', async () => {
    const db = createMigratedD1();
    seed(db);
    const tenant = makeTenant({ db, mode: 'saas' }); // saas → proven
    const a = await getAnalytics(tenant, { domainId: 1, days: 30, now: NOW, lookupDmarc: async () => 'v=DMARC1; p=none' }) as any;
    expect(a.totals.messages).toBe(100);
    expect(a.totals.pass_rate).toBe(50);
    expect(a.readiness.metrics.pass_rate).toBe(50); // not 97%: the forged reports are not in it
    expect(a.report_counting).toBe('registry');
    expect(a.uncounted.reports).toBe(3);
    expect(a.uncounted).toMatchObject({ unknown: 1, unauthenticated: 1 });
    expect(a.reporters.attribution).toBe('from 1 report by google.com');

    const report = await getDomainReport(tenant, 1, { now: NOW, resolver: { txt: async () => ({ status: 'ok', records: [] }) } as any, resolvers: [{ txt: async () => ({ status: 'ok', records: [] }) } as any] }).catch(() => null) as any;
    if (report) {
      expect(report.sections.dmarc.report_counting).toBe('registry');
      expect(report.sections.dmarc.uncounted.reports).toBe(3);
    }
  });

  it('self-host default: everything counts, and the same fields say how many reports are unverified', async () => {
    const db = createMigratedD1();
    seed(db);
    const tenant = makeTenant({ db }); // selfhost → all
    expect(tenant.scope.counting).toBe('all');
    const a = await getAnalytics(tenant, { domainId: 1, days: 30, now: NOW, lookupDmarc: async () => 'v=DMARC1; p=none' }) as any;
    expect(a.totals.messages).toBe(1800);
    expect(a.report_counting).toBe('all');
    expect(a.uncounted.reports).toBe(0);
    expect(a.unrecognised.reports).toBe(3);
  });

  it('a flood of unproven reports does not push proven ones out of "latest N"', async () => {
    const db = createMigratedD1();
    const s = db.sqlite;
    s.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'x')").run();
    const old = Math.floor((NOW - 20 * DAY) / DAY) * DAY;
    s.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, reporter_auth, reporter_tier) VALUES (1, 1, 'google.com', 'real', ?, ?, 'pass', 'counted')").run(old, old + DAY - 1);
    const ins = s.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, reporter_auth, reporter_tier) VALUES (1, 'f', ?, ?, ?, 'none', 'unauthenticated')");
    for (let i = 0; i < 300; i++) ins.run(`flood-${i}`, NOW - i, NOW - i + DAY);
    const recent = await forWorkspace(db, 'ws_default', { counting: 'registry' }).reports.recent(30);
    expect(recent[0].report_id).toBe('real');
    expect(recent).toHaveLength(30);
    // in `all` mode everything counts, so newest first as before
    expect((await forWorkspace(db, 'ws_default', { counting: 'all' }).reports.recent(5))[0].report_id).toMatch(/^flood-/);
  });

  it('a caller that does not say how to count never counts unproven reports', async () => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default');
    expect(q.counting).toBe('registry');
    expect((await q.reports.dailyStats(1, begin - DAY)).reduce((n, r) => n + r.total, 0)).toBe(100);
  });
});

describe('REPORT_COUNTING defaults', () => {
  it('saas: proven. selfhost: all. An explicit value wins; garbage falls back to the default of the mode', () => {
    expect(reportCounting({ MODE: 'saas' })).toBe('registry');
    expect(reportCounting({})).toBe('all');
    expect(reportCounting({ MODE: 'saas', REPORT_COUNTING: 'all' })).toBe('all');
    expect(reportCounting({ REPORT_COUNTING: ' Authenticated ' })).toBe('authenticated');
    expect(reportCounting({ MODE: 'saas', REPORT_COUNTING: 'yes' })).toBe('registry');
    expect(reportCounting({ REPORT_COUNTING: 'yes' })).toBe('all');
  });
});

describe('the weekly digest never says "no reports" when reports were left out', () => {
  const stat = (o: object) => ({ domain_id: 1, domain: 'acme.com', dmarc_policy: 'none', total_messages: 0, pass_messages: 0, fail_messages: 0, report_count: 0, uncounted_reports: 0, ...o });
  it('only unverified reports', () => {
    const body = buildDigestBody('Ann', [stat({ uncounted_reports: 2 })] as any, new Map(), 'Mar 3', 'rua@x', 'x');
    expect(body).toContain('No counted reports this week. 2 reports from senders we do not recognise are not counted.');
    expect(body).not.toContain('No reports received this week.');
  });
  it('counted numbers plus the note', () => {
    const body = buildDigestBody('Ann', [stat({ total_messages: 10, pass_messages: 9, fail_messages: 1, report_count: 1, uncounted_reports: 1 })] as any, new Map(), 'Mar 3', 'rua@x', 'x');
    expect(body).toContain('1 report from a sender we do not recognise is not counted.');
  });
  it('nothing at all still says so', () => {
    expect(buildDigestBody('Ann', [stat({})] as any, new Map(), 'Mar 3', 'rua@x', 'x')).toContain('No reports received this week.');
  });
});
