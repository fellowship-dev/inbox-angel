// The security review's blocker 2 and finding 4, through the real email() entry point.
//   - Uncounted reports (tier unknown/unauthenticated) have their OWN storage budgets, so strangers cannot push a known reporter's report out.
//   - A COUNTED report dropped because the counted budget is genuinely full is loud: owner-visible state on the domain and a setup-check finding.
//   - Counted reports are keyed on (domain, reporter identity, report id).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { forWorkspace, resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { generateToken, hashToken } from '../../src/hosted/tokens';
import { reportVisibility } from '../../src/reports/visibility';
import { intakeSetupFindings } from '../../src/reports/auth-status';
import { storageDropNotice } from '../../web/src/lib/uncounted';
import { makeTenant } from '../helpers/tenant';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { reportWithDistinctIps } from '../helpers/big-report';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const ID = 'mx.cloudflare.net';
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const googleEml = readFileSync(resolve(__dirname, '../fixtures/third-party/mox/google.eml'), 'utf8').replace('Authentication-Results: koriander.ueber.net;', `Authentication-Results: ${ID};`);
type World = Awaited<ReturnType<typeof twoWorkspaces>>;

async function own(w: World, domain: string) {
  const id = 100 + Math.floor(Math.random() * 1e6);
  w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, 'ws_a', ?, 'x')").run(id, domain);
  const token = generateToken();
  await forWorkspace(w.env.DB, 'ws_a').intake.set(id, await hashToken(token), NOW);
  return { token, id };
}
/** The last structured intake line, in call order (accepted lines go to console.log, refused ones to console.warn). */
const log = () => {
  const calls = [console.log, console.warn].flatMap((f: any) => f.mock.calls.map((c: any[], i: number) => ({ line: String(c[0]), order: f.mock.invocationCallOrder[i] })));
  return calls.filter((c) => c.line.startsWith('{"evt":"intake"')).sort((x, y) => x.order - y.order).map((c) => JSON.parse(c.line)).at(-1);
};
async function deliver(w: World, token: string, eml: string, from: string, env: Record<string, string> = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(`rua+${token}@${RUA}`, eml, { from, headers: {} });
  await worker.email(m, { ...w.env, ...env } as any, ctx);
  return m;
}
const deliverGoogle = (w: World, token: string, env: Record<string, string> = {}) => deliver(w, token, googleEml, 'noreply-dmarc-support@google.com', env);
/** A report for `domain` from an authenticated sender that is not in the registry: From, DKIM d= and the report email all at `org`. */
const attacker = (w: World, token: string, domain: string, org: string, id: string, records: number, env: Record<string, string> = {}) => {
  const xml = reportWithDistinctIps(domain, id, records).replaceAll('google.com', org);
  const eml = gzipReportMime(xml).replace('From: noreply-dmarc-support@google.com', `From: noreply-dmarc-support@${org}`);
  return deliver(w, token, `Authentication-Results: ${ID}; dkim=pass header.d=${org} header.s=s1\r\n${eml}`, `noreply-dmarc-support@${org}`, env);
};
const counted = (w: World) => w.rows("SELECT report_id, reporter_identity i, reporter_known_as k FROM aggregate_reports WHERE reporter_tier = 'counted' ORDER BY id");
const storage = (w: World) => w.rows("SELECT records, uncounted_records u, reports, uncounted_reports ur FROM workspace_storage WHERE workspace_id = 'ws_a'");

/** How many records the real Google fixture holds. */
async function googleRecords() {
  const w = await twoWorkspaces();
  const { token } = await own(w, 'ueber.net');
  await deliverGoogle(w, token);
  return w.rows('SELECT record_count n FROM aggregate_reports')[0].n as number;
}

describe('uncounted reports cannot starve a known reporter (the reviewer\'s scenario)', () => {
  it('four attacker DKIM domains fill the uncounted budget; the real Google report through email() is still stored and counted', async () => {
    const g = await googleRecords();
    const w = await twoWorkspaces();
    const { token } = await own(w, 'ueber.net');
    // The counted cap fits Google's report but NOT Google's plus the attackers': under the old shared budget Google would have been dropped.
    const env = { INTAKE_MAX_WORKSPACE_RECORDS: String(g + 5), INTAKE_MAX_UNCOUNTED_WORKSPACE_RECORDS: '40', INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY: '1000' };
    for (const org of ['evil-one.example', 'evil-two.example', 'evil-three.example', 'evil-four.example']) {
      expect((await attacker(w, token, 'ueber.net', org, 'x-' + org, 10, env)).setReject, org).not.toHaveBeenCalled();
      expect(log()).toMatchObject({ outcome: 'accepted', tier: 'unknown' });
    }
    expect(storage(w)).toEqual([{ records: 0, u: 40, reports: 0, ur: 4 }]);
    // the uncounted budget is full: a fifth stranger is refused, not stored
    const fifth = await attacker(w, token, 'ueber.net', 'evil-five.example', 'x-5', 10, env);
    expect(fifth.setReject).toHaveBeenCalledWith('Storage limit for reports from senders this service does not know reached for this account');
    expect(log()).toMatchObject({ outcome: 'refused', reason: 'cap_uncounted_workspace_storage' });
    // Google: accepted, stored, counted
    const m = await deliverGoogle(w, token, env);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(log()).toMatchObject({ outcome: 'accepted', tier: 'counted', reporter: 'google', dedup: 'new' });
    expect(counted(w)).toEqual([{ report_id: 'google|' + w.rows("SELECT report_id FROM aggregate_reports WHERE reporter_tier = 'counted'")[0].report_id.slice(7), i: 'google', k: 'Google' }]);
    expect(storage(w)).toEqual([{ records: g, u: 40, reports: 1, ur: 4 }]);
    expect(w.rows("SELECT reason FROM intake_failures")).toEqual([]); // nothing was dropped
    expect(w.rows('SELECT COUNT(*) n FROM intake_drops')).toEqual([{ n: 0 }]);
  });

  it('per-address and instance-wide uncounted budgets are separate too', async () => {
    const w = await twoWorkspaces();
    const { token } = await own(w, 'ueber.net');
    const env = { INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY: '15', INTAKE_MAX_UNCOUNTED_INSTANCE_RECORDS: '1000', INTAKE_MAX_ADDRESS_RECORDS_PER_DAY: '1' };
    expect((await attacker(w, token, 'ueber.net', 'evil-one.example', 'a1', 10, env)).setReject).not.toHaveBeenCalled();
    const over = await attacker(w, token, 'ueber.net', 'evil-two.example', 'a2', 10, env);
    expect(over.setReject).toHaveBeenCalledWith('Daily record limit for reports from senders this service does not know reached for this address; try again tomorrow');
    // the counted per-address budget is 1 record per day here, untouched by the strangers: it is Google's own limit that decides
    const instEnv = { INTAKE_MAX_UNCOUNTED_INSTANCE_RECORDS: '12' };
    const w2 = await twoWorkspaces();
    const t2 = await own(w2, 'ueber.net');
    expect((await attacker(w2, t2.token, 'ueber.net', 'evil-one.example', 'i1', 10, instEnv)).setReject).not.toHaveBeenCalled();
    expect((await attacker(w2, t2.token, 'ueber.net', 'evil-two.example', 'i2', 10, instEnv)).setReject).toHaveBeenCalledWith('The service has reached its storage limit for reports from unknown senders');
    expect((await deliverGoogle(w2, t2.token, instEnv)).setReject).not.toHaveBeenCalled();
    expect(counted(w2)).toHaveLength(1);
  });

  it('unauthenticated mail is an uncounted tier with the same separate budget', async () => {
    const w = await twoWorkspaces();
    const { token } = await own(w, 'ueber.net');
    const env = { INTAKE_MAX_UNCOUNTED_WORKSPACE_RECORDS: '3' };
    // the real Google report without any authentication results: stored as unauthenticated, in the uncounted budget
    await deliver(w, token, googleEml.replace(/^Authentication-Results: [\s\S]*?dkim-atps=neutral\r?\n/im, ''), 'noreply-dmarc-support@google.com', env);
    expect(w.rows('SELECT reporter_tier t FROM aggregate_reports')).toEqual([{ t: 'unauthenticated' }]);
    expect(storage(w)[0]).toMatchObject({ records: 0 });
    expect(storage(w)[0].u).toBeGreaterThan(0);
  });

  it('a later promotion is not blocked: the sweep keys on the stored tier, so a report whose tier becomes counted leaves it', () => {
    // Promotion is later work. What matters here is that nothing is keyed on the identity string: retention and the budgets read reporter_tier only.
    const sweep = readFileSync(resolve(__dirname, '../../packages/db/src/queries/global-lifecycle.ts'), 'utf8');
    expect(sweep).toContain("reporter_tier IN ('unknown', 'unauthenticated')");
  });
});

describe('a counted report dropped because the counted budget is genuinely full is loud', () => {
  it('owner-visible state on the domain (reporter, first drop time), and a setup-check finding', async () => {
    const g = await googleRecords();
    const w = await twoWorkspaces();
    const { token, id } = await own(w, 'ueber.net');
    const env = { INTAKE_MAX_WORKSPACE_RECORDS: String(g - 1) }; // the counted budget cannot hold Google's report
    const m = await deliverGoogle(w, token, env);
    expect(m.setReject).not.toHaveBeenCalled(); // never a 5xx to Google
    expect(log()).toMatchObject({ outcome: 'accepted', reason: 'over_cap_accepted_dropped' });
    expect(counted(w)).toEqual([]);
    const row = w.rows('SELECT reporter, label, first_at, messages FROM intake_drops WHERE domain_id = ?', id)[0];
    expect(row).toMatchObject({ reporter: 'google', label: 'Google', messages: 1 });

    // the domain's visibility fields
    const tenant = makeTenant({ db: w.db, workspaceId: 'ws_a', env: { ...w.env, ...env } as any, mode: 'saas' });
    const v = await reportVisibility(tenant, id, 0);
    const text = /^Report storage limit reached; reports from Google since \d{4}-\d\d-\d\d \d\d:\d\d UTC were not stored$/;
    expect(v.intake).toMatchObject({ status: 'limited', limit: 'counted_storage_dropped' });
    expect(v.intake.dropped).toHaveLength(1);
    expect(v.intake.dropped[0]).toMatchObject({ reporter: 'google', label: 'Google', messages: 1 });
    expect(new Date(v.intake.dropped[0].since).toISOString()).toBe(v.intake.dropped[0].since); // ISO, rendered by the web helper
    expect(v.intake.dropped[0].text).toMatch(text);
    expect(v.intake.notice).toMatch(text);
    // the web helper renders the same sentence in the user's locale and time zone
    expect(storageDropNotice(v.intake.dropped[0], { locale: 'en-GB', timeZone: 'Pacific/Auckland' })).toMatch(/^Report storage limit reached; reports from Google since \d{1,2} \w{3} \d{4}, \d\d:\d\d were not stored$/);
    expect(storageDropNotice({ label: 'Google', since: '2026-11-14T03:12:00.000Z' }, { locale: 'en-US', timeZone: 'America/Los_Angeles' }).replace(/\u202f/g, ' ')).toBe('Report storage limit reached; reports from Google since Nov 13, 2026, 7:12 PM were not stored');

    // the owner's setup check
    const findings = await intakeSetupFindings({ DB: w.env.DB, MODE: 'saas', AUTHSERV_ID: ID, AUTHSERV_HEADER: 'ar' });
    const f = findings.find((x) => x.message.startsWith('Report storage limit reached;'));
    expect(f).toMatchObject({ id: 'intake', severity: 'action' });
    expect(f!.message).toMatch(/^Report storage limit reached; reports from Google since \d{4}-\d\d-\d\d \d\d:\d\d UTC were not stored\./);

    // the next Google report once there is room: stored, and the state clears
    const ok = await deliver(w, token, googleEml.replace(/^Message-ID:.*$/im, '$&'), 'noreply-dmarc-support@google.com', { INTAKE_MAX_WORKSPACE_RECORDS: String(g * 10) });
    expect(ok.setReject).not.toHaveBeenCalled();
    expect(counted(w)).toHaveLength(1);
    expect(w.rows('SELECT COUNT(*) n FROM intake_drops')).toEqual([{ n: 0 }]);
    expect((await reportVisibility(tenant, id, 0)).intake.dropped).toEqual([]);
    expect((await intakeSetupFindings({ DB: w.env.DB, MODE: 'saas', AUTHSERV_ID: ID, AUTHSERV_HEADER: 'ar' })).some((x) => x.message.startsWith('Report storage limit reached;'))).toBe(false);
  });

  it('the first drop time is kept across later drops', async () => {
    const w = await twoWorkspaces();
    const { id } = await own(w, 'ueber.net');
    const q = forWorkspace(w.env.DB, 'ws_a').intake;
    await q.markDrop(id, 'google', 'Google', 1000);
    await q.markDrop(id, 'google', 'Google', 5000);
    expect(await q.drops(id, 0)).toEqual([{ reporter: 'google', label: 'Google', first_at: 1000, last_at: 5000, messages: 2 }]);
    expect(await q.drops(id, 6000)).toEqual([]); // stale: nothing dropped lately
  });
});

describe('counted reports are keyed on (domain, reporter identity, report id)', () => {
  const dkim = (d: string) => `Authentication-Results: ${ID}; dkim=pass header.d=${d} header.s=s1\r\n`;
  const asFrom = (mime: string, from: string) => mime.replace('From: noreply-dmarc-support@google.com', `From: ${from}`);
  const google = (w: World, token: string, id: string) => deliver(w, token, dkim('google.com') + gzipReportMime(dmarcXml('a-corp.com', id, 'google.com')), 'noreply-dmarc-support@google.com');
  const ms = (w: World, token: string, id: string) => {
    const xml = dmarcXml('a-corp.com', id, 'microsoft.com').replace('noreply-dmarc-support@microsoft.com', 'dmarcreport@microsoft.com');
    return deliver(w, token, dkim('microsoft.com') + asFrom(gzipReportMime(xml), 'dmarcreport@microsoft.com'), 'dmarcreport@microsoft.com');
  };

  it('Google and Microsoft with the same report id are both stored and counted; redelivery of each is a duplicate', async () => {
    const w = await twoWorkspaces();
    await google(w, w.tokenA, 'same');
    expect(log()).toMatchObject({ outcome: 'accepted', tier: 'counted', reporter: 'google', dedup: 'new' });
    await ms(w, w.tokenA, 'same');
    expect(log()).toMatchObject({ outcome: 'accepted', tier: 'counted', reporter: 'microsoft', dedup: 'new' });
    expect(w.rows("SELECT report_id, reporter_identity i, reporter_tier t FROM aggregate_reports ORDER BY id")).toEqual([
      { report_id: 'google|same', i: 'google', t: 'counted' }, { report_id: 'microsoft|same', i: 'microsoft', t: 'counted' },
    ]);
    await google(w, w.tokenA, 'same');
    expect(log()).toMatchObject({ outcome: 'duplicate', dedup: 'duplicate' });
    await ms(w, w.tokenA, 'same');
    expect(log()).toMatchObject({ outcome: 'duplicate', dedup: 'duplicate' });
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports')).toEqual([{ n: 2 }]);
    expect(w.rows('SELECT records, reports FROM workspace_storage WHERE workspace_id = ?', 'ws_a')).toEqual([{ records: 2, reports: 2 }]);
  });

  it('a legacy plain-id row (stored before this key, identity NULL or the same reporter) is still a duplicate on redelivery', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, workspace_id, reporter_tier, reporter_identity) VALUES (1, 'google.com', 'legacy', 1, 2, 'ws_a', 'counted', 'google')").run();
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, workspace_id) VALUES (1, 'old', 'older', 1, 2, 'ws_a')").run();
    await google(w, w.tokenA, 'legacy');
    expect(log()).toMatchObject({ outcome: 'duplicate' });
    await google(w, w.tokenA, 'older'); // NULL identity: cannot be told apart, so it is the same report
    expect(log()).toMatchObject({ outcome: 'duplicate' });
    // another reporter's plain legacy id (identity google) does not hide Microsoft's report with that id
    await ms(w, w.tokenA, 'legacy');
    expect(log()).toMatchObject({ outcome: 'accepted', dedup: 'new' });
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports')).toEqual([{ n: 3 }]);
  });

  it('supersede still works: a counted report replaces an uncounted one with the same id, and an uncounted one never doubles a counted one', async () => {
    const w = await twoWorkspaces();
    const forged = { rawHeaderLines: ['Authentication-Results: attacker.example; dkim=pass header.d=google.com'] };
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'same-id')), forged);
    await worker.email(m, w.env as any, ctx);
    expect(w.rows('SELECT report_id, reporter_tier t FROM aggregate_reports')).toEqual([{ report_id: '~unauth|same-id', t: 'unauthenticated' }]);
    expect(w.rows("SELECT uncounted_records u, records FROM workspace_storage WHERE workspace_id = 'ws_a'")).toEqual([{ u: 1, records: 0 }]);
    await google(w, w.tokenA, 'same-id');
    expect(w.rows('SELECT report_id, reporter_tier t FROM aggregate_reports')).toEqual([{ report_id: 'google|same-id', t: 'counted' }]);
    expect(w.rows("SELECT uncounted_records u, records, uncounted_reports ur, reports FROM workspace_storage WHERE workspace_id = 'ws_a'")).toEqual([{ u: 0, records: 1, ur: 0, reports: 1 }]);
    const m2 = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'same-id')), forged);
    await worker.email(m2, w.env as any, ctx);
    expect(w.rows('SELECT report_id FROM aggregate_reports')).toEqual([{ report_id: 'google|same-id' }]);
  });
});

describe('retention: uncounted reports (unknown and unauthenticated) are kept 30 days and give back only their own budget', () => {
  it('sweeps both tiers after 30 days, keeps counted ones, and the counters follow', async () => {
    const { runRetention } = await import('../../src/lifecycle/retention');
    const w = await twoWorkspaces();
    const { token } = await own(w, 'ueber.net');
    await attacker(w, token, 'ueber.net', 'evil-one.example', 'k1', 6); // unknown tier
    await deliver(w, token, gzipReportMime(dmarcXml('ueber.net', 'u1')), 'x@spam.example'); // unauthenticated
    await deliverGoogle(w, token); // counted
    const g = w.rows("SELECT record_count n FROM aggregate_reports WHERE reporter_tier = 'counted'")[0].n as number;
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    // inside the 13 months for every tier (date_end), past 30 days for two of them, 10 days for the counted one
    w.db.sqlite.prepare("UPDATE aggregate_reports SET date_end = ?, created_at = ? WHERE reporter_tier IN ('unknown', 'unauthenticated')").run(now - 40 * day, now - 40 * day);
    w.db.sqlite.prepare("UPDATE aggregate_reports SET date_end = ?, created_at = ? WHERE reporter_tier = 'counted'").run(now - 40 * day, now - 40 * day);
    const r = await runRetention({ DB: w.env.DB, MODE: 'saas' } as any, { now: () => now * 1000 });
    expect(r.aggregate_reports).toBe(2);
    expect(w.rows('SELECT reporter_tier t FROM aggregate_reports')).toEqual([{ t: 'counted' }]);
    expect(storage(w)).toEqual([{ records: g, u: 0, reports: 1, ur: 0 }]);
    expect(w.rows("SELECT scope, records FROM intake_quota WHERE day = 'total' ORDER BY scope")).toEqual([{ scope: '*', records: g }, { scope: '*u', records: 0 }]);
    // the daily recount agrees with the live counters
    w.db.sqlite.prepare('UPDATE workspace_storage SET records = 999, uncounted_records = 999').run();
    await runRetention({ DB: w.env.DB, MODE: 'saas' } as any, { now: () => now * 1000 });
    expect(storage(w)).toEqual([{ records: g, u: 0, reports: 1, ur: 0 }]);
  });
});

describe('an operator registry entry cannot reuse a built-in id (through email())', () => {
  it('google|Evil|evil.com|...: evil.com is not counted, so it is not "safe to enforce" evidence; the real Google still counts', async () => {
    const w = await twoWorkspaces();
    const { token, id } = await own(w, 'ueber.net');
    const env = { INTAKE_KNOWN_REPORTERS: 'google|Evil|evil.com|noreply-dmarc-support@evil.com|noreply-dmarc-support@evil.com' };
    const m = await attacker(w, token, 'ueber.net', 'evil.com', 'e1', 3, env);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(log()).toMatchObject({ tier: 'unknown', reporter: 'evil.com' });
    expect(counted(w)).toEqual([]);
    const tenant = makeTenant({ db: w.db, workspaceId: 'ws_a', env: { ...w.env, ...env } as any, mode: 'saas' });
    expect((await reportVisibility(tenant, id, 0)).reporters.major).toBe(false);
    await deliverGoogle(w, token, env);
    expect(counted(w)).toHaveLength(1);
    expect((await reportVisibility(tenant, id, 0)).reporters).toMatchObject({ major: true, attribution: 'from 1 report by Google' });
  });
});
