// G5: a report counts toward the numbers only when its sender was proven. Every aggregate query, the analytics service the
// dashboard and agents share, the digest, and the "latest N" list are held to it. A forger with a public token must not move a
// pass rate, a failing-sender list, an anomaly, a level or "safe to enforce".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forWorkspace, resetSchemaReadyCache, type CountingMode } from '@inbox-angel/db';
import { createMigratedD1 } from '@inbox-angel/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { getAnalytics } from '../../src/reports/analytics';
import { getDomainReport } from '../../src/reports/service';
import { reportCounting } from '../../src/dmarc/counting';
import { reporterAuth, provenReporter, mayBeReporter, SHARED_MAILBOX_DOMAINS } from '../../src/dmarc/reporter-auth';
import { buildDigestBody } from '../../src/digest/weekly';
import { makeTenant } from '../helpers/tenant';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.inboxangel.io';
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const ID = 'mx.cloudflare.net';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// ── seeded data: a real report that fails, and a forged report that passes ──────────

function seed(db: ReturnType<typeof createMigratedD1>, ws = 'ws_default') {
  const s = db.sqlite;
  s.prepare("INSERT OR IGNORE INTO domains (id, domain, rua_address, workspace_id) VALUES (1, 'acme.com', 'x', ?)").run(ws);
  const report = (id: number, auth: string | null, total: number, pass: number, ip: string, begin: number, org = 'google.com') => {
    s.prepare('INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id, reporter_auth, reporter_auth_domain) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, org, `r${id}`, begin, begin + DAY - 1, total, pass, total - pass, ws, auth, auth === 'pass' ? org : null);
    s.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, spf_result, header_from, workspace_id) VALUES (?, ?, ?, ?, ?, ?, 'acme.com', ?)")
      .run(id, ip, total, pass === total ? 'none' : 'reject', pass === total ? 'pass' : 'fail', pass === total ? 'pass' : 'fail', ws);
  };
  const begin = Math.floor((NOW - 2 * DAY) / DAY) * DAY;
  report(1, 'pass', 100, 50, '198.51.100.1', begin);                    // the real one: half of the mail fails
  report(2, 'none', 1000, 1000, '203.0.113.7', begin, 'forger.example'); // forged: "100% pass", unproven
  report(3, 'fail', 500, 500, '203.0.113.8', begin, 'google.com');       // claims google, not proven
  report(4, null, 200, 200, '203.0.113.9', begin, 'old.example');        // stored before the column existed
  return { begin };
}

const modes: CountingMode[] = ['proven', 'all'];

describe('every aggregate query counts only proven reports (and everything in `all` mode)', () => {
  it.each(modes)('%s: the daily totals, pass rate and day summary', async (mode) => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const since = begin - DAY;
    const stats = await q.reports.dailyStats(1, since);
    const total = stats.reduce((n, r) => n + r.total, 0);
    const passed = stats.reduce((n, r) => n + r.passed, 0);
    expect(mode === 'proven' ? { total, passed } : { total, passed }).toEqual(mode === 'proven' ? { total: 100, passed: 50 } : { total: 1800, passed: 1750 });
    const day = new Date(begin * 1000).toISOString().slice(0, 10);
    expect(await q.reports.daySummary(1, day)).toEqual(mode === 'proven' ? { total: 100, passed: 50, failed: 50 } : { total: 1800, passed: 1750, failed: 50 });
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
    expect(ips(await q.reports.allSources(1, since))).toEqual(mode === 'proven' ? real : everything);
    expect(ips(await q.reports.sourcesByDate(1, day))).toEqual(mode === 'proven' ? real : everything);
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
    const q = forWorkspace(db, 'ws_default', { counting: 'proven' });
    expect(await q.reports.topFailingSources(1, begin - DAY)).toEqual([]);
    expect(await q.reports.anomalySources(1, begin - DAY)).toEqual([]);
  });

  it.each(modes)('%s: weekly digest stats, check summary (levels), evidence and the first-report count', async (mode) => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const since = begin - DAY;
    const [w] = await q.reports.weeklyDomainStats(since);
    expect({ total: w.total_messages, reports: w.report_count, uncounted: w.uncounted_reports }).toEqual(mode === 'proven' ? { total: 100, reports: 1, uncounted: 3 } : { total: 1800, reports: 4, uncounted: 0 });
    const cs = (await q.reports.checkSummary(1, since))!;
    expect(cs.total_messages).toBe(mode === 'proven' ? 100 : 1800);
    expect(cs.dkim_total).toBe(mode === 'proven' ? 100 : 1800);
    const ev = await q.reports.evidence(1, since, NOW);
    expect(ev.dmarc.report_count).toBe(mode === 'proven' ? 1 : 4);
    expect(ev.dmarc.observations.map((o) => o.source_report_id).sort()).toEqual(mode === 'proven' ? ['r1'] : ['r1', 'r2', 'r3', 'r4']);
    expect(await q.reports.countForDomain(1)).toBe(mode === 'proven' ? 1 : 4);
    const exported = await q.reports.exportData(1);
    expect(exported.filter((r) => r.counted).length).toBe(mode === 'proven' ? 1 : 4); // every row is there, labelled
    expect(exported.length).toBe(4);
  });

  it.each(modes)('%s: analytics (trend, sender inventory, readiness inputs, workspace totals)', async (mode) => {
    const db = createMigratedD1();
    seed(db);
    const q = forWorkspace(db, 'ws_default', { counting: mode });
    const now = NOW;
    const rows = await q.analytics.senderRows(null, now - 30 * DAY, now - 30 * DAY, now);
    expect(rows.map((r) => r.source_ip).sort()).toEqual(mode === 'proven' ? ['198.51.100.1'] : ['198.51.100.1', '203.0.113.7', '203.0.113.8', '203.0.113.9']);
    const trend = await q.analytics.trend(null, now - 30 * DAY, now);
    expect(trend.reduce((n, r) => n + r.total, 0)).toBe(mode === 'proven' ? 100 : 1800);
    const totals = await q.analytics.domainTotals(now - 30 * DAY, now);
    expect(totals[0].total).toBe(mode === 'proven' ? 100 : 1800);
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
    expect(a.report_counting).toBe('proven');
    expect(a.uncounted.reports).toBe(3);
    expect(a.uncounted.by_reporter.map((r: any) => r.reporter).sort()).toEqual(['forger.example', 'google.com', 'old.example']);

    const report = await getDomainReport(tenant, 1, { now: NOW, resolver: { txt: async () => ({ status: 'ok', records: [] }) } as any, resolvers: [{ txt: async () => ({ status: 'ok', records: [] }) } as any] }).catch(() => null) as any;
    if (report) {
      expect(report.sections.dmarc.report_counting).toBe('proven');
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
    expect(a.unverified.reports).toBe(3);
  });

  it('a flood of unproven reports does not push proven ones out of "latest N"', async () => {
    const db = createMigratedD1();
    const s = db.sqlite;
    s.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'x')").run();
    const old = Math.floor((NOW - 20 * DAY) / DAY) * DAY;
    s.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, reporter_auth) VALUES (1, 1, 'google.com', 'real', ?, ?, 'pass')").run(old, old + DAY - 1);
    const ins = s.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, reporter_auth) VALUES (1, 'f', ?, ?, ?, 'none')");
    for (let i = 0; i < 300; i++) ins.run(`flood-${i}`, NOW - i, NOW - i + DAY);
    const recent = await forWorkspace(db, 'ws_default', { counting: 'proven' }).reports.recent(30);
    expect(recent[0].report_id).toBe('real');
    expect(recent).toHaveLength(30);
    // in `all` mode everything counts, so newest first as before
    expect((await forWorkspace(db, 'ws_default', { counting: 'all' }).reports.recent(5))[0].report_id).toMatch(/^flood-/);
  });

  it('a caller that does not say how to count never counts unproven reports', async () => {
    const db = createMigratedD1();
    const { begin } = seed(db);
    const q = forWorkspace(db, 'ws_default');
    expect(q.counting).toBe('proven');
    expect((await q.reports.dailyStats(1, begin - DAY)).reduce((n, r) => n + r.total, 0)).toBe(100);
  });
});

describe('REPORT_COUNTING defaults', () => {
  it('saas: proven. selfhost: all. An explicit value wins; garbage falls back to the default of the mode', () => {
    expect(reportCounting({ MODE: 'saas' })).toBe('proven');
    expect(reportCounting({})).toBe('all');
    expect(reportCounting({ MODE: 'saas', REPORT_COUNTING: 'all' })).toBe('all');
    expect(reportCounting({ REPORT_COUNTING: ' Proven ' })).toBe('proven');
    expect(reportCounting({ MODE: 'saas', REPORT_COUNTING: 'yes' })).toBe('proven');
    expect(reportCounting({ REPORT_COUNTING: 'yes' })).toBe('all');
  });
});

describe('the weekly digest never says "no reports" when reports were left out', () => {
  const stat = (o: object) => ({ domain_id: 1, domain: 'acme.com', dmarc_policy: 'none', total_messages: 0, pass_messages: 0, fail_messages: 0, report_count: 0, uncounted_reports: 0, ...o });
  it('only unverified reports', () => {
    const body = buildDigestBody('Ann', [stat({ uncounted_reports: 2 })] as any, new Map(), 'Mar 3', 'rua@x', 'x');
    expect(body).toContain('No counted reports this week. 2 reports from senders we could not verify are not counted.');
    expect(body).not.toContain('No reports received this week.');
  });
  it('counted numbers plus the note', () => {
    const body = buildDigestBody('Ann', [stat({ total_messages: 10, pass_messages: 9, fail_messages: 1, report_count: 1, uncounted_reports: 1 })] as any, new Map(), 'Mar 3', 'rua@x', 'x');
    expect(body).toContain('1 report from a sender we could not verify is not counted.');
  });
  it('nothing at all still says so', () => {
    expect(buildDigestBody('Ann', [stat({})] as any, new Map(), 'Mar 3', 'rua@x', 'x')).toContain('No reports received this week.');
  });
});

// ── what "proven" means ─────────────────────────────────────────────────────────────

const env = { AUTHSERV_ID: ID, AUTHSERV_HEADER: 'ar' };
const ar = (v: string, from: string | null = null) => ({ ar: `${ID}; ${v}`, arc: null, from });

describe('proven: the receiver\'s topmost header, aligned with the domain the REPORT names', () => {
  it('pass: an aligned DKIM pass, or a DMARC pass, for the report\'s own domain', () => {
    expect(reporterAuth(ar('dkim=pass header.d=google.com'), { org_email: 'noreply@google.com', org_name: 'google.com' }, env)).toEqual({ result: 'pass', domain: 'google.com', reason: null });
    expect(reporterAuth(ar('dmarc=pass header.from=mail.example.org'), { org_email: 'dmarc@example.org', org_name: 'Example' }, env).result).toBe('pass');
  });

  it('a forger with her own authenticated domain is proven as that domain, never as google.com', () => {
    const forged = ar('dkim=pass header.d=evil.example');
    expect(reporterAuth(forged, { org_email: 'noreply@google.com', org_name: 'google.com' }, env)).toMatchObject({ result: 'fail', domain: 'google.com', reason: 'not_aligned' });
    expect(reporterAuth(forged, { org_email: 'x@evil.example', org_name: 'google.com' }, env)).toMatchObject({ result: 'fail', reason: 'org_mismatch' }); // names two organisations
    expect(reporterAuth(forged, { org_email: 'x@evil.example', org_name: 'evil.example' }, env)).toMatchObject({ result: 'pass', domain: 'evil.example' }); // honest about who she is
  });

  it('a header the sender added (another authserv-id), or the other header kind, proves nothing', () => {
    expect(reporterAuth({ ar: 'attacker.example; dkim=pass header.d=google.com', arc: null }, { org_email: 'a@google.com', org_name: '' }, env)).toMatchObject({ result: 'fail', reason: 'authserv_id_not_found' });
    expect(reporterAuth({ ar: null, arc: `i=1; ${ID}; dkim=pass header.d=google.com` }, { org_email: 'a@google.com', org_name: '' }, env)).toMatchObject({ result: 'fail' }); // AUTHSERV_HEADER=ar ignores ARC
    expect(reporterAuth({ ar: null, arc: `i=1; ${ID}; dkim=pass header.d=google.com` }, { org_email: 'a@google.com', org_name: '' }, { ...env, AUTHSERV_HEADER: 'arc' }).result).toBe('pass');
  });

  it('nothing is proven until AUTHSERV_ID and AUTHSERV_HEADER are set, and with no results header', () => {
    expect(reporterAuth(ar('dkim=pass header.d=google.com'), { org_email: 'a@google.com', org_name: '' }, {})).toMatchObject({ result: 'none', reason: 'authserv_not_configured' });
    expect(reporterAuth({ ar: null, arc: null }, { org_email: 'a@google.com', org_name: '' }, env)).toMatchObject({ result: 'none', reason: 'no_results_header' });
    expect(provenReporter(ar('dkim=pass header.d=google.com'), {})).toBeNull();
  });
});

describe('shared-mailbox domains: a random mailbox on yahoo.com / outlook.com / gmail.com is never a reporter', () => {
  const yahoo = { org_email: 'postmaster@dmarc.yahoo.com', org_name: 'Yahoo' };
  const TRUSTED = { ...env, INTAKE_TRUSTED_REPORTER_ADDRESSES: 'noreply@dmarc.yahoo.com, Other@Report.Example' };

  it.each(['yahoo.com', 'outlook.com', 'hotmail.com', 'gmail.com', 'icloud.com', 'amazonses.com', 'proton.me', 'gmx.de'])('%s is on the list', (d) => {
    expect(SHARED_MAILBOX_DOMAINS.has(d)).toBe(true);
  });
  it('google.com and microsoft.com are not shared-mailbox domains (consumers sign as gmail.com / outlook.com)', () => {
    expect(SHARED_MAILBOX_DOMAINS.has('google.com')).toBe(false);
    expect(SHARED_MAILBOX_DOMAINS.has('microsoft.com')).toBe(false);
  });

  it('DKIM-passing mail from an arbitrary yahoo.com mailbox is not proven, whatever the report claims', () => {
    const h = ar('dkim=pass header.d=yahoo.com', 'attacker@yahoo.com');
    expect(reporterAuth(h, yahoo, env)).toMatchObject({ result: 'fail', domain: 'yahoo.com', reason: 'shared_mailbox_domain' });
    expect(reporterAuth(h, yahoo, TRUSTED)).toMatchObject({ result: 'fail', reason: 'shared_mailbox_domain' }); // not on the trusted list
    expect(provenReporter(h, TRUSTED)).toBeNull(); // and charged to the unproven bucket, not the proven slot-free path
  });

  it('proven only when the From address is exactly a trusted report-sender address of that organisation', () => {
    const good = ar('dkim=pass header.d=dmarc.yahoo.com', 'noreply@dmarc.yahoo.com');
    expect(reporterAuth(good, yahoo, TRUSTED)).toEqual({ result: 'pass', domain: 'yahoo.com', reason: null });
    expect(provenReporter(good, TRUSTED)).toBe('yahoo.com');
    // one character off, another organisation's address, no From at all, a list of addresses
    for (const from of ['noreply@yahoo.com', 'noreply@dmarc.yahoo.com.evil.example', 'xnoreply@dmarc.yahoo.com', null]) {
      expect(reporterAuth(ar('dkim=pass header.d=dmarc.yahoo.com', from), yahoo, TRUSTED).result, String(from)).toBe('fail');
    }
    // a trusted address of ANOTHER organisation does not make yahoo.com provable
    expect(reporterAuth(ar('dkim=pass header.d=yahoo.com', 'other@report.example'), yahoo, TRUSTED).result).toBe('fail');
    // the variable is case-insensitive and tolerant of separators; a malformed entry is ignored
    expect(mayBeReporter('yahoo.com', { ar: null, arc: null, from: 'noreply@dmarc.yahoo.com' }, { INTAKE_TRUSTED_REPORTER_ADDRESSES: ' NOREPLY@dmarc.yahoo.com;garbage ' })).toBe(true);
    expect(mayBeReporter('yahoo.com', { ar: null, arc: null, from: 'noreply@dmarc.yahoo.com' }, { INTAKE_TRUSTED_REPORTER_ADDRESSES: 'garbage' })).toBe(false);
  });

  it('there is no built-in address for these providers (none is documented with enough certainty), so they need the variable', () => {
    expect(mayBeReporter('yahoo.com', { ar: null, arc: null, from: 'noreply@dmarc.yahoo.com' }, {})).toBe(false);
  });
});

describe('through the real email() entry point', () => {
  /** `headers.from` becomes the message's From header (the MIME helper's own From is replaced, not duplicated). */
  const send = async (w: Awaited<ReturnType<typeof twoWorkspaces>>, xml: string, headers: Record<string, string>, o: { from?: string } = {}, extraEnv: Record<string, string> = {}) => {
    const { from, ...rest } = headers;
    const mime = from ? gzipReportMime(xml).replace(/^From: .*\r\n/, `From: ${from}\r\n`) : gzipReportMime(xml);
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, mime, { headers: rest, ...o });
    await worker.email(m, { ...w.env, ...extraEnv } as any, ctx);
    return m;
  };
  const aggregates = async (w: Awaited<ReturnType<typeof twoWorkspaces>>) => {
    const q = forWorkspace(w.env.DB, 'ws_a', { counting: 'proven' });
    return (await q.reports.dailyStats(1, 0)).reduce((n, r) => n + r.total, 0);
  };

  it('a forged "google.com" report from another domain is stored, flagged, and not counted; the real one counts', async () => {
    const w = await twoWorkspaces();
    const forged = await send(w, dmarcXml('a-corp.com', 'forged', 'google.com'), { 'authentication-results': `${ID}; dkim=pass header.d=evil.example` }, { from: 'x@evil.example' });
    const real = await send(w, dmarcXml('a-corp.com', 'real', 'google.com'), { 'authentication-results': `${ID}; dkim=pass header.d=google.com` });
    expect(forged.setReject).not.toHaveBeenCalled();
    expect(real.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id, reporter_auth, reporter_auth_reason FROM aggregate_reports ORDER BY id')).toEqual([
      { report_id: 'forged', reporter_auth: 'fail', reporter_auth_reason: 'not_aligned' },
      { report_id: 'real', reporter_auth: 'pass', reporter_auth_reason: null },
    ]);
    expect(await aggregates(w)).toBe(3); // only the real report's 3 messages
  });

  it('with AUTHSERV_* unset (the first deploy) nothing counts, and the owner is told why', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: '', AUTHSERV_HEADER: '' });
    await send(w, dmarcXml('a-corp.com', 'first'), { 'authentication-results': `${ID}; dkim=pass header.d=google.com` });
    expect(w.rows('SELECT reporter_auth, reporter_auth_reason FROM aggregate_reports')).toEqual([{ reporter_auth: 'none', reporter_auth_reason: 'authserv_not_configured' }]);
    expect(await aggregates(w)).toBe(0);
    const u = await forWorkspace(w.env.DB, 'ws_a').reports.unverified(1, 0);
    expect(u).toMatchObject({ reports: 1, messages: 3 });
  });

  it('a yahoo.com mailbox claiming to be Yahoo\'s reporting system is stored but never counted', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'y1', 'yahoo.com'), { 'authentication-results': `${ID}; dkim=pass header.d=yahoo.com`, from: 'someone@yahoo.com' }, { from: 'someone@yahoo.com' });
    expect(w.rows('SELECT reporter_auth, reporter_auth_reason FROM aggregate_reports')).toEqual([{ reporter_auth: 'fail', reporter_auth_reason: 'shared_mailbox_domain' }]);
    expect(await aggregates(w)).toBe(0);
  });

  it('the same report from the trusted address counts', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'y2', 'dmarc.yahoo.com'), { 'authentication-results': `${ID}; dkim=pass header.d=yahoo.com`, from: 'noreply@dmarc.yahoo.com' }, {}, { INTAKE_TRUSTED_REPORTER_ADDRESSES: 'noreply@dmarc.yahoo.com' });
    expect(w.rows('SELECT reporter_auth, reporter_auth_domain FROM aggregate_reports')).toEqual([{ reporter_auth: 'pass', reporter_auth_domain: 'yahoo.com' }]);
    expect(await aggregates(w)).toBe(3);
  });
});
