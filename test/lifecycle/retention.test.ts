// The daily retention job, against a real in-memory D1 and a fixed clock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { retentionPolicy, rawXmlRetentionDays } from '../../src/lifecycle/config';
import { runRetention } from '../../src/lifecycle/retention';
import { LIFECYCLE_CRON, runCronForWorkspaces, runDataLifecycle } from '../../src/cron';
import { storeReport } from '../../src/dmarc/store-report';
import { makeTenant } from '../helpers/tenant';

const DAY = 86400;
const NOW = Date.UTC(2026, 9, 23, 8, 0, 0) / 1000; // 2026-10-23 08:00 UTC
const clock = () => NOW * 1000;
const ago = (days: number) => NOW - days * DAY;

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function seed() {
  const db = createMigratedD1();
  const s = db.sqlite;
  const n = (sql: string) => (s.prepare(sql).get() as { n: number }).n;
  s.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'example.com', 'rua@x')").run();
  const rep = s.prepare('INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, raw_xml, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)');
  const rec = s.prepare("INSERT INTO report_records (report_id, source_ip, disposition) VALUES (?, '1.2.3.4', 'none')");
  // id 1: ended 400 days ago (past 13 months). id 2: 390 days ago (inside). id 3: recent, raw XML 40 days old. id 4: recent, raw 10 days old.
  rep.run(1, 'g', 'old', ago(401), ago(400), '<x/>', ago(399));
  rep.run(2, 'g', 'edge', ago(391), ago(390), '<x/>', ago(389));
  rep.run(3, 'g', 'mid', ago(41), ago(40), '<x/>', ago(40));
  rep.run(4, 'g', 'new', ago(11), ago(10), '<x/>', ago(10));
  for (const id of [1, 1, 2, 3, 4]) rec.run(id);
  const tls = s.prepare('INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, raw_json, created_at) VALUES (1, ?, ?, ?, ?, ?)');
  tls.run('old', ago(401), ago(400), '{}', ago(399));
  tls.run('new', ago(11), ago(10), '{}', ago(10));
  const ip = s.prepare("INSERT INTO ip_info (ip, fetched_at) VALUES (?, ?)");
  ip.run('9.9.9.9', ago(31)); ip.run('8.8.8.8', ago(29));
  const chk = s.prepare("INSERT INTO check_results (from_email, from_domain, overall_status, created_at) VALUES ('a@b.c', 'b.c', 'pass', ?)");
  chk.run(ago(31)); chk.run(ago(29));
  s.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'u@x.com', 'U')").run();
  const sess = s.prepare("INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, 'u1', ?, ?)");
  sess.run('s1', 't1', ago(1)); sess.run('s2', 't2', NOW + DAY);
  const ver = s.prepare("INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?, 'reset-password:x', 'u1', ?)");
  ver.run('v1', ago(1)); ver.run('v2', NOW + DAY);
  const prt = s.prepare("INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, 'u1', ?)");
  prt.run('p1', ago(1)); prt.run('p2', NOW + DAY);
  const inv = s.prepare("INSERT INTO invites (token, email, invited_by, expires_at) VALUES (?, 'i@x.com', 'u1', ?)");
  inv.run('i1', ago(31)); inv.run('i2', ago(29)); inv.run('i3', NOW + DAY);
  const aud = s.prepare("INSERT INTO audit_log (action, created_at) VALUES ('x', ?)");
  aud.run(ago(366)); aud.run(ago(364));
  return { db, s, n };
}

const ids = (s: any, table: string, col = 'id') => (s.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY 1`).all() as any[]).map(r => r.v);

describe('runRetention (self-host defaults)', () => {
  it('deletes exactly what is past its window, and keeps the rest', async () => {
    const { db, s, n } = seed();
    const report = await runRetention({ DB: db as any }, { now: clock });
    expect(report).toMatchObject({ aggregate_reports: 1, tls_reports: 1, ip_info: 1, check_results: 1, sessions: 1, verifications: 1, password_reset_tokens: 1, invites: 1, audit_log: 1, failed: 0 });
    expect(ids(s, 'aggregate_reports')).toEqual([2, 3, 4]);
    expect(n('SELECT COUNT(*) n FROM report_records WHERE report_id = 1')).toBe(0);
    expect(n('SELECT COUNT(*) n FROM report_records')).toBe(3);
    expect(ids(s, 'tls_reports', 'org_name')).toEqual(['new']);
    expect(ids(s, 'ip_info', 'ip')).toEqual(['8.8.8.8']);
    expect(n('SELECT COUNT(*) n FROM check_results')).toBe(1);
    expect(ids(s, 'sessions')).toEqual(['s2']);
    expect(ids(s, 'verifications')).toEqual(['v2']);
    expect(ids(s, 'password_reset_tokens', 'token')).toEqual(['p2']);
    expect(ids(s, 'invites', 'token')).toEqual(['i2', 'i3']);
    expect(n('SELECT COUNT(*) n FROM audit_log')).toBe(1);
  });

  it('raw XML: cleared after 30 days, the parsed report stays', async () => {
    const { db, s } = seed();
    await runRetention({ DB: db as any }, { now: clock });
    const raw = (s.prepare('SELECT id, raw_xml FROM aggregate_reports ORDER BY id').all() as any[]).map(r => [r.id, r.raw_xml]);
    expect(raw).toEqual([[2, null], [3, null], [4, '<x/>']]);
    const tlsRaw = (s.prepare('SELECT raw_json FROM tls_reports').all() as any[]).map(r => r.raw_json);
    expect(tlsRaw).toEqual(['{}']);
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const { db, s } = seed();
    await runRetention({ DB: db as any }, { now: clock });
    const snapshot = JSON.stringify(s.prepare('SELECT * FROM aggregate_reports ORDER BY id').all());
    const again = await runRetention({ DB: db as any }, { now: clock });
    expect(Object.entries(again).filter(([k, v]) => typeof v === 'number' && k !== 'failed' && k !== 'statements_left').every(([, v]) => v === 0)).toBe(true);
    expect(JSON.stringify(s.prepare('SELECT * FROM aggregate_reports ORDER BY id').all())).toBe(snapshot);
  });

  it('moves with the clock: a row survives until its window passes, then goes', async () => {
    const { db, s } = seed();
    await runRetention({ DB: db as any }, { now: clock });
    expect(ids(s, 'aggregate_reports')).toEqual([2, 3, 4]);
    // 5 days later, report 2 (ended 390 days ago) is past 395; two weeks on, report 4's raw XML is past 30 days
    await runRetention({ DB: db as any }, { now: () => clock() + 6 * DAY * 1000 });
    expect(ids(s, 'aggregate_reports')).toEqual([3, 4]);
    expect((s.prepare('SELECT raw_xml FROM aggregate_reports WHERE id = 4').get() as any).raw_xml).toBe('<x/>');
    await runRetention({ DB: db as any }, { now: () => clock() + 21 * DAY * 1000 });
    expect((s.prepare('SELECT raw_xml FROM aggregate_reports WHERE id = 4').get() as any).raw_xml).toBeNull();
  });

  it('works through a backlog in batches, and says when it stopped early', async () => {
    const { db, s, n } = seed();
    const rep = s.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end) VALUES (1, 'g', ?, ?, ?)");
    for (let i = 0; i < 10; i++) rep.run(`bulk-${i}`, ago(500), ago(499));
    const first = await runRetention({ DB: db as any }, { now: clock, limits: { batch: 3, statements: 4 } });
    expect(first).toMatchObject({ aggregate_reports: 6, aggregate_reports_truncated: true });
    expect(n("SELECT COUNT(*) n FROM aggregate_reports WHERE report_id LIKE 'bulk-%'")).toBe(5);
    const second = await runRetention({ DB: db as any }, { now: clock, limits: { batch: 3, statements: 4 } });
    expect(second.aggregate_reports).toBe(5); // the rest of the bulk rows
    expect(second.aggregate_reports_truncated).toBeUndefined();
    expect(n("SELECT COUNT(*) n FROM aggregate_reports WHERE report_id LIKE 'bulk-%'")).toBe(0);
  });

  it('one failing sweep is logged and the others still run', async () => {
    const { db, s } = seed();
    s.exec('DROP TABLE ip_info');
    const report = await runRetention({ DB: db as any }, { now: clock });
    expect(report.failed).toBe(1);
    expect(report.ip_info_error).toBeTruthy();
    expect(report.sessions).toBe(1);
  });

  it('logs one JSON line with the counts', async () => {
    const { db } = seed();
    const log = vi.spyOn(console, 'log');
    await runRetention({ DB: db as any }, { now: clock });
    const line = log.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[retention] '))!;
    expect(JSON.parse(line.slice('[retention] '.length))).toMatchObject({ aggregate_reports: 1, failed: 0 });
  });
});

describe('windows from the environment', () => {
  it('defaults are the published ones', () => {
    expect(retentionPolicy({})).toEqual({ reportsDays: 395, tlsDays: 395, rawDays: 30, ipInfoDays: 30, checkResultsDays: 30, invitesDays: 30, auditDays: 365 });
  });

  it('overrides apply; garbage falls back to the default instead of disabling a window', () => {
    expect(retentionPolicy({ RETENTION_AUDIT_DAYS: '90', RETENTION_IP_INFO_DAYS: '7' })).toMatchObject({ auditDays: 90, ipInfoDays: 7 });
    expect(retentionPolicy({ RETENTION_AUDIT_DAYS: '0', RETENTION_REPORTS_DAYS: 'abc', RETENTION_TLS_DAYS: '-5', RETENTION_INVITES_DAYS: '1.5' })).toMatchObject({ auditDays: 365, reportsDays: 395, tlsDays: 395, invitesDays: 30 });
  });

  it('raw XML: 30 days self-host, 0 (never store) hosted, either overridable', () => {
    expect(rawXmlRetentionDays({})).toBe(30);
    expect(rawXmlRetentionDays({ MODE: 'saas' })).toBe(0);
    expect(rawXmlRetentionDays({ MODE: 'saas', RAW_XML_RETENTION_DAYS: '7' })).toBe(7);
    expect(rawXmlRetentionDays({ RAW_XML_RETENTION_DAYS: '0' })).toBe(0);
  });

  it('a shorter audit window deletes more', async () => {
    const { db, n } = seed();
    await runRetention({ DB: db as any, RETENTION_AUDIT_DAYS: '30' }, { now: clock });
    expect(n('SELECT COUNT(*) n FROM audit_log')).toBe(0);
  });

  it('RAW_XML_RETENTION_DAYS=0 clears every stored raw payload', async () => {
    const { db, s } = seed();
    await runRetention({ DB: db as any, RAW_XML_RETENTION_DAYS: '0' }, { now: clock });
    expect(s.prepare('SELECT COUNT(*) n FROM aggregate_reports WHERE raw_xml IS NOT NULL').get()).toEqual({ n: 0 });
  });
});

describe('raw XML is not stored in hosted mode', () => {
  const report = (id: string) => ({
    xml_schema: 'draft', report_metadata: { org_name: 'google.com', org_email: 'x@google.com', org_extra_contact_info: null, report_id: id, begin_date: '2026-10-01T00:00:00Z', end_date: '2026-10-01T23:59:59Z', errors: [] },
    policy_published: { domain: 'example.com', adkim: 'r', aspf: 'r', p: 'none', sp: 'none', pct: 100, fo: '0' }, records: [],
  }) as any;

  it('hosted drops it by default, self-host keeps it, RAW_XML_RETENTION_DAYS decides either way', async () => {
    for (const [env, mode, expected] of [
      [{ MODE: 'saas' }, 'saas', null], [{}, undefined, '<xml/>'], [{ MODE: 'saas', RAW_XML_RETENTION_DAYS: '30' }, 'saas', '<xml/>'], [{ RAW_XML_RETENTION_DAYS: '0' }, undefined, null],
    ] as const) {
      const db = createMigratedD1();
      db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'example.com', 'rua@x')").run();
      await storeReport(makeTenant({ db, env: env as any, mode: mode as any }), 1, report('r1'), '<xml/>');
      expect((db.sqlite.prepare('SELECT raw_xml FROM aggregate_reports').get() as any).raw_xml).toBe(expected);
    }
  });
});

describe('statement budget, big reports, far-future dates', () => {
  it('a whole run never issues more statements than its budget, and says which sweeps it did not finish', async () => {
    const { db, s } = seed();
    const rep = s.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end) VALUES (1, 'g', ?, ?, ?)");
    for (let i = 0; i < 40; i++) rep.run(`bulk-${i}`, ago(500), ago(499));
    let statements = 0;
    const counted = new Proxy(db as any, { get: (t, k) => (k === 'prepare' ? (sql: string) => { statements++; return t.prepare(sql); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    const report = await runRetention({ DB: counted }, { now: clock, limits: { batch: 5, statements: 6 } });
    expect(statements).toBeLessThanOrEqual(6);
    expect(report.aggregate_reports_truncated).toBe(true);
    expect(report.statements_left).toBe(0);
    // later sweeps got nothing this run (the budget is shared), so they are reported unfinished too
    expect(report.audit_log_truncated).toBe(true);
    // the default budget is 300
    statements = 0;
    await runRetention({ DB: counted }, { now: clock });
    expect(statements).toBeLessThanOrEqual(300);
  });

  it('a report with many records is purged a bounded number of records per statement', async () => {
    const { db, s, n } = seed();
    const ins = s.prepare("INSERT INTO report_records (report_id, source_ip, disposition) VALUES (1, ?, 'none')");
    for (let i = 0; i < 25; i++) ins.run(`10.0.0.${i}`);
    // 27 records on report 1, 10 per statement: three statements empty it, and the report itself waits for the next run
    const first = await runRetention({ DB: db as any }, { now: clock, limits: { recordBatch: 10, statements: 3 } });
    expect(first.aggregate_reports_truncated).toBe(true);
    expect(n('SELECT COUNT(*) n FROM report_records WHERE report_id = 1')).toBe(0);
    expect(n('SELECT COUNT(*) n FROM aggregate_reports WHERE id = 1')).toBe(1); // records first, then the report
    const second = await runRetention({ DB: db as any }, { now: clock, limits: { recordBatch: 10 } });
    expect(second.aggregate_reports).toBe(1);
    expect(n('SELECT COUNT(*) n FROM aggregate_reports WHERE id = 1')).toBe(0);
    expect(n('SELECT COUNT(*) n FROM report_records WHERE report_id = 1')).toBe(0);
  });

  it('a report claiming a far-future end date is still purged by when it was received', async () => {
    const { db, s, n } = seed();
    s.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, created_at) VALUES (99, 1, 'g', 'future', ?, ?, ?)").run(NOW, NOW + 3000 * DAY, ago(400));
    s.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, created_at) VALUES (1, 'future', ?, ?, ?)").run(NOW, NOW + 3000 * DAY, ago(400));
    await runRetention({ DB: db as any }, { now: clock });
    expect(n('SELECT COUNT(*) n FROM aggregate_reports WHERE id = 99')).toBe(0);
    expect(n("SELECT COUNT(*) n FROM tls_reports WHERE org_name = 'future'")).toBe(0);
  });
});

describe('cron entry', () => {
  it('the lifecycle trigger runs the job and nothing per-workspace; other triggers do not run it', async () => {
    const { db, n } = seed();
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const load = vi.fn();
    await runCronForWorkspaces({ cron: '0 9 * * 1' } as any, { DB: db } as any, {} as any, { workspaces: [], load });
    expect(n('SELECT COUNT(*) n FROM audit_log')).toBe(2);
    await runCronForWorkspaces({ cron: LIFECYCLE_CRON } as any, { DB: db } as any, {} as any, { workspaces: ['ws_default'], load });
    expect(load).not.toHaveBeenCalled();
    expect(n('SELECT COUNT(*) n FROM audit_log')).toBe(1);
  });

  it('revocations are retried before the sweeps', async () => {
    const { db } = seed();
    const order: string[] = [];
    db.sqlite.prepare("INSERT INTO revocation_tombstones (id, deleted_workspace_id, connection_id, token_envelope) VALUES ('t', 'ws_x', 'c', 'junk')").run();
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { if (/revocation_tombstones/.test(sql)) order.push('revoke'); else if (/DELETE FROM aggregate_reports/.test(sql)) order.push('sweep'); return prepare(sql); };
    await runDataLifecycle({ DB: db } as any);
    expect(order.indexOf('revoke')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('revoke')).toBeLessThan(order.indexOf('sweep'));
  });
});
