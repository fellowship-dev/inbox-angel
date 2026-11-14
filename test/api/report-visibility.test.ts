// The server fields the dashboard renders (src/reports/visibility.ts): which reports are left out of the numbers, and mail that
// reached the report address and could not be stored. A page must never be able to show "no reports" while either exists.
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/index';
import { createMigratedD1, type TestD1 } from '@ready-set-mail/db/testing';
import { IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error { constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; } },
}));
vi.mock('../../src/dns/provision', () => ({ provisionDomain: vi.fn(), deprovisionDomain: vi.fn(), DnsProvisionError: class extends Error {} }));

import { handleApi } from '../../src/api/router';
import { seedSettings } from '../helpers/tenant';
import { intakeView, STORAGE_LIMIT_NOTICE, DAILY_LIMIT_NOTICE } from '../../src/reports/visibility';
import { intakeLimits } from '../../src/hosted/config';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const NOW = Math.floor(Date.now() / 1000);
const day = (ago = 0) => new Date((NOW - ago * 86400) * 1000).toISOString().slice(0, 10);

function world(extra: Record<string, string> = {}) {
  const DB: TestD1 = createMigratedD1();
  seedSettings(DB, { reports_domain: 'reports.readysetmail.com', from_email: 'check@reports.readysetmail.com' });
  DB.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (1, ?, 'acme.com', 'rua@reports.readysetmail.com')").run(IMPLICIT_WORKSPACE_ID);
  const begin = Math.floor((NOW - 2 * 86400) / 86400) * 86400;
  // tier: counted (authenticated + registry), unknown (authenticated, not in the registry), unauthenticated
  const rep = (id: number, tier: 'counted' | 'unknown' | 'unauthenticated', total: number, org: string) => DB.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id, reporter_auth, reporter_tier) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)").run(id, org, `r${id}`, begin, begin + 86399, total, total, IMPLICIT_WORKSPACE_ID, tier === 'unauthenticated' ? 'none' : 'pass', tier);
  return { env: { DB, API_KEY: 'k', ...extra } as unknown as Env & { DB: TestD1 }, DB, rep };
}
const get = async (env: any, path: string) => { const res = await handleApi(new Request(`https://x.test${path}`, { headers: { 'x-api-key': 'k' } }), env, ctx); return { res, body: await res.clone().json().catch(() => null) as any, text: await res.text() }; };

describe('GET /api/domains/:id/stats and /check-summary', () => {
  it('registry mode: counted numbers, plus what was left out, by reporter', async () => {
    const w = world({ REPORT_COUNTING: 'registry' });
    w.rep(1, 'counted', 100, 'google.com');
    w.rep(2, 'unknown', 900, 'forger.example');
    w.rep(3, 'unauthenticated', 50, 'forger.example');
    const { body } = await get(w.env, '/api/domains/1/stats?days=30');
    expect(body.stats.reduce((n: number, r: any) => n + r.total, 0)).toBe(100);
    expect(body.report_counting).toBe('registry');
    expect(body.uncounted).toMatchObject({ reports: 2, messages: 950, unknown: 1, unauthenticated: 1, by_reporter: [{ reporter: 'forger.example', reports: 1 }, { reporter: 'unverified sender', reports: 1, unverified: true, claims: 'forger.example' }] });
    expect(body.unrecognised).toMatchObject({ reports: 2, unknown: 1, unauthenticated: 1 });
    expect(body.intake).toMatchObject({ status: 'ok', notice: null });
    const cs = (await get(w.env, '/api/domains/1/check-summary')).body;
    expect(cs.total_messages).toBe(100);
    expect(cs.uncounted.reports).toBe(2);
  });

  it('only uncounted reports: zero counted, and the fields say reports exist', async () => {
    const w = world({ REPORT_COUNTING: 'registry' });
    w.rep(1, 'unauthenticated', 900, 'forger.example');
    const { body } = await get(w.env, '/api/domains/1/stats?days=30');
    expect(body.stats).toEqual([]);
    expect(body.uncounted.reports).toBe(1);
  });

  it('all mode (the self-host default): everything counted, nothing "uncounted", the unrecognised figure still reported', async () => {
    const w = world();
    w.rep(1, 'counted', 100, 'google.com');
    w.rep(2, 'unknown', 900, 'x.example');
    const { body } = await get(w.env, '/api/domains/1/stats?days=30');
    expect(body.report_counting).toBe('all');
    expect(body.stats.reduce((n: number, r: any) => n + r.total, 0)).toBe(1000);
    expect(body.uncounted.reports).toBe(0);
    expect(body.unrecognised).toMatchObject({ reports: 1, unknown: 1, unauthenticated: 0 });
  });

  it('reports that could not be stored are visible, so the page cannot say "no reports"', async () => {
    const w = world();
    w.DB.sqlite.prepare("INSERT INTO intake_failures (domain_id, workspace_id, day, reason, messages, last_at) VALUES (1, ?, ?, 'storage_failed', 2, ?), (1, ?, ?, 'too_many_records', 1, ?)").run(IMPLICIT_WORKSPACE_ID, day(), NOW, IMPLICIT_WORKSPACE_ID, day(1), NOW - 86400);
    const { body } = await get(w.env, '/api/domains/1/stats?days=30');
    expect(body.stats).toEqual([]);
    expect(body.intake.status).toBe('not_processed');
    expect(body.intake.notice).toBe('3 reports received for this domain could not be processed');
    expect(body.intake.not_processed.messages).toBe(3);
    expect(body.intake.not_processed.reasons.map((r: any) => r.reason).sort()).toEqual(['storage_failed', 'too_many_records']);
    expect(body.intake.not_processed.reasons.find((r: any) => r.reason === 'storage_failed').text).toBe('Temporary storage failure; try again later');
  });

  it('failures older than the window are not shown', async () => {
    const w = world();
    w.DB.sqlite.prepare("INSERT INTO intake_failures (domain_id, workspace_id, day, reason, messages, last_at) VALUES (1, ?, ?, 'storage_failed', 4, 1)").run(IMPLICIT_WORKSPACE_ID, day(40));
    expect((await get(w.env, '/api/domains/1/stats')).body.intake.status).toBe('ok');
  });
});

describe('GET /api/reports and the CSV export label what counts', () => {
  it('each report says whether it counts; no internal ingest id leaks', async () => {
    const w = world({ REPORT_COUNTING: 'registry' });
    w.rep(1, 'counted', 100, 'google.com');
    w.rep(2, 'unknown', 900, 'x.example');
    w.DB.sqlite.prepare("UPDATE aggregate_reports SET ingest_token = 'secret-attempt-id' WHERE id = 1").run();
    const { body, text } = await get(w.env, '/api/reports');
    expect(body.report_counting).toBe('registry');
    expect(body.reports[0]).toMatchObject({ report_id: 'r1', counted: true }); // counted first
    expect(body.reports.find((r: any) => r.report_id === 'r2').counted).toBe(false);
    expect(text).not.toContain('secret-attempt-id');
    const csv = (await get(w.env, '/api/domains/1/export')).text;
    expect(csv.split('\n')[0]).toMatch(/,counted$/);
    expect(csv).toContain('"google.com"');
    expect(csv.split('\n').filter((l) => l.endsWith('"yes"'))).toHaveLength(1);
    expect(csv.split('\n').filter((l) => l.endsWith('"no"'))).toHaveLength(1);
  });
});

describe('limits in force are shown with the exact notice', () => {
  const lim = intakeLimits({ MODE: 'saas' });
  const none = { addressMessagesToday: 0, workspaceMessagesToday: 0, workspaceRecords: 0, instanceRecords: 0 };
  it('storage limit', () => {
    const v = intakeView([], { ...none, workspaceRecords: lim.workspaceRecords }, lim);
    expect(v).toMatchObject({ status: 'limited', limit: 'workspace_storage', notice: 'Report storage limit reached; newer reports are not being stored' });
    expect(STORAGE_LIMIT_NOTICE).toBe('Report storage limit reached; newer reports are not being stored');
    expect(intakeView([], { ...none, instanceRecords: lim.instanceRecords }, lim).limit).toBe('instance_storage');
  });
  it('daily limit', () => {
    const v = intakeView([], { ...none, addressMessagesToday: lim.addressMessagesPerDay }, lim);
    expect(v).toMatchObject({ status: 'limited', limit: 'address_day', notice: DAILY_LIMIT_NOTICE });
    expect(DAILY_LIMIT_NOTICE).toBe('Daily report limit reached for this address; newer reports are not being stored until tomorrow');
    expect(intakeView([], { ...none, workspaceMessagesToday: lim.workspaceMessagesPerDay }, lim).limit).toBe('workspace_day');
  });
  it('a limit outranks earlier failures; neither means ok; self-host has no daily limits', () => {
    expect(intakeView([{ reason: 'storage_failed', messages: 1, last_at: 1 }], { ...none, workspaceRecords: lim.workspaceRecords }, lim).status).toBe('limited');
    expect(intakeView([], none, lim)).toMatchObject({ status: 'ok', notice: null });
    expect(intakeView([{ reason: 'storage_failed', messages: 1, last_at: 1 }], null, null)).toMatchObject({ status: 'not_processed', notice: '1 report received for this domain could not be processed' });
    expect(intakeView([{ reason: 'no_attachment', messages: 5, last_at: 1 }], null, null).status).toBe('ok'); // junk mail is not "a report we could not process"
  });
});
