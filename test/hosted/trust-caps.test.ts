// Trust hardening on the hosted intake: per-token caps, exact policy_published, reporter authentication,
// the per-workspace hosted-domain cap, and the zip/gzip bomb cap in self-host.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { gzipSync, zipSync, strToU8 } from 'fflate';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { handleHostedEmail } from '../../src/hosted/intake';
import { enableHosted } from '../../src/hosted/service';
import { intakeLimits, DEFAULT_MAX_REPORTS_PER_DAY, DEFAULT_MAX_RECORDS_PER_REPORT, DEFAULT_MAX_BYTES_PER_DAY } from '../../src/hosted/config';
import { carrierFromHeaders, decideTier } from '../../src/dmarc/reporter-auth';
import { makeEnv } from '../auth/helpers';
import { makeTenant } from '../helpers/tenant';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment, zipReportMime } from '../helpers/mail';
import { dnsFrom } from './dns';
import { HOSTED_ENV, nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const send = async (w: Awaited<ReturnType<typeof twoWorkspaces>>, xml: string, o: Parameters<typeof fakeMessage>[2] = {}) => {
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(xml), o);
  await handleHostedEmail(m, w.env);
  return m;
};

type W = Awaited<ReturnType<typeof twoWorkspaces>>;
const dkimHdr = (d: string) => ({ headers: { 'authentication-results': `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1` } });
const asFrom = (mime: string, from: string) => mime.replace('From: noreply-dmarc-support@google.com', `From: ${from}`);
/** A message from an authenticated sender that is NOT in the registry: From, DKIM d= and the report's own email all at `org`. */
const sendUnknownXml = async (w: W, org: string, xml: string, o: Parameters<typeof fakeMessage>[2] = {}) => {
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, asFrom(gzipReportMime(xml), `noreply-dmarc-support@${org}`), { ...dkimHdr(org), from: `noreply-dmarc-support@${org}`, ...o });
  await handleHostedEmail(m, w.env);
  return m;
};
const sendUnknown = (w: W, org: string, id: string, o: Parameters<typeof fakeMessage>[2] = {}) => sendUnknownXml(w, org, dmarcXml('a-corp.com', id, org), o);
/** Microsoft's registry entry: From and report email dmarcreport@microsoft.com, DKIM d=microsoft.com. */
const sendMs = async (w: W, id: string) => {
  const xml = dmarcXml('a-corp.com', id, 'microsoft.com').replace('noreply-dmarc-support@microsoft.com', 'dmarcreport@microsoft.com');
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, asFrom(gzipReportMime(xml), 'dmarcreport@microsoft.com'), { ...dkimHdr('microsoft.com'), from: 'dmarcreport@microsoft.com' });
  await handleHostedEmail(m, w.env);
  return m;
};
const dropped = (w: W) => w.rows("SELECT reason, messages FROM intake_failures WHERE reason = 'over_cap_accepted_dropped'");

function manyRecords(domain: string, reportId: string, n: number, org = 'google.com'): string {
  const rec = (i: number) => `<record><row><source_ip>198.51.${Math.floor(i / 250)}.${i % 250 + 1}</source_ip><count>1</count>
    <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers></record>`;
  const base = dmarcXml(domain, reportId, org);
  return base.replace(/<record>[\s\S]*<\/record>/, Array.from({ length: n }, (_, i) => rec(i)).join('\n'));
}

describe('defaults and env overrides', () => {
  it('have sane defaults; bad values fall back', () => {
    expect(intakeLimits({ MODE: 'saas' })).toMatchObject({ reportsPerDay: DEFAULT_MAX_REPORTS_PER_DAY, recordsPerReport: DEFAULT_MAX_RECORDS_PER_REPORT, bytesPerDay: DEFAULT_MAX_BYTES_PER_DAY });
    expect(intakeLimits({ MODE: 'saas', INTAKE_MAX_REPORTS_PER_DAY: '7', INTAKE_MAX_RECORDS_PER_REPORT: 'x', INTAKE_MAX_BYTES_PER_DAY: '-1' })).toMatchObject({ reportsPerDay: 7, recordsPerReport: DEFAULT_MAX_RECORDS_PER_REPORT, bytesPerDay: DEFAULT_MAX_BYTES_PER_DAY });
  });
});

describe('per-token caps (a counted registry reporter over a cap is accepted and dropped, never answered with a 5xx)', () => {
  it('reports per day: the next one is accepted but not stored, counted for the owner, and the other workspace is unaffected', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (const id of ['r1', 'r2']) expect((await send(w, dmarcXml('a-corp.com', id), GOOGLE)).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'r3'), GOOGLE);
    expect(over.setReject).not.toHaveBeenCalled();
    expect(dropped(w)).toEqual([{ reason: 'over_cap_accepted_dropped', messages: 1 }]);
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['google|r1', 'google|r2']);
    expect(w.rows('SELECT domain_id, workspace_id, reporter, reports FROM intake_usage')).toEqual([{ domain_id: 1, workspace_id: 'ws_a', reporter: 'google', reports: 2 }]);

    const b = fakeMessage(`rua+${w.tokenB}@${RUA}`, gzipReportMime(dmarcXml('b-corp.org', 'rb')), GOOGLE);
    await handleHostedEmail(b, w.env);
    expect(b.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id FROM aggregate_reports WHERE domain_id = 2')).toEqual([{ report_id: 'google|rb' }]);
  });

  it('a new UTC day starts a new allowance', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T23:00:00Z'));
      expect((await send(w, dmarcXml('a-corp.com', 'd1'), GOOGLE)).setReject).not.toHaveBeenCalled();
      expect((await send(w, dmarcXml('a-corp.com', 'd1b'), GOOGLE)).setReject).not.toHaveBeenCalled(); // dropped
      expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['google|d1']);
      vi.setSystemTime(new Date('2030-01-02T00:01:00Z'));
      expect((await send(w, dmarcXml('a-corp.com', 'd2'), GOOGLE)).setReject).not.toHaveBeenCalled();
      expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['google|d1', 'google|d2']);
    } finally { vi.useRealTimers(); }
  });

  it('bytes per day: counted from the raw message size, dropped when they would exceed the cap', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_BYTES_PER_DAY: '1000' });
    for (const [id, rawSize] of [['b1', 600], ['b2', 600], ['b3', 400], ['b4', 1]] as const) expect((await send(w, dmarcXml('a-corp.com', id), { ...GOOGLE, rawSize })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reports, bytes FROM intake_usage')).toEqual([{ reports: 2, bytes: 1000 }]); // b3 fits exactly
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['google|b1', 'google|b3']);
    expect(dropped(w)).toEqual([{ reason: 'over_cap_accepted_dropped', messages: 2 }]);
  });

  it('records per report: refused before any IP enrichment fetch; nothing stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_RECORDS_PER_REPORT: '5' });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ Status: 3 })));
    vi.stubGlobal('fetch', fetchSpy);
    const m = await send(w, manyRecords('a-corp.com', 'big', 6), GOOGLE);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(m.setReject.mock.calls[0][0]).toMatch(/6 records; the limit is 5/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);

    expect((await send(w, manyRecords('a-corp.com', 'ok', 5), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(5);
  });

  it('new-IP enrichment is capped per message but every record is still stored', async () => {
    const run = async (cap: string) => {
      const w = await twoWorkspaces({ INTAKE_MAX_NEW_IPS_PER_REPORT: cap });
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ Status: 3 })));
      vi.stubGlobal('fetch', fetchSpy);
      expect((await send(w, manyRecords('a-corp.com', 'ips', 6), GOOGLE)).setReject).not.toHaveBeenCalled();
      expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(6);
      return fetchSpy.mock.calls.length;
    };
    const one = await run('1');
    const three = await run('3');
    expect(one).toBeGreaterThan(0);
    expect(three).toBe(one * 3);
  });
});

describe('caps by carrier class: records per report and IP enrichment', () => {
  it('an authenticated unknown reporter has its own lower records cap: refused before anything is stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNKNOWN_RECORDS_PER_REPORT: '3' });
    expect((await sendUnknown(w, 'stranger.example', 'u1')).setReject).not.toHaveBeenCalled();
    const m = await sendUnknownXml(w, 'stranger.example', manyRecords('a-corp.com', 'u4', 4, 'stranger.example'));
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(m.setReject.mock.calls[0][0]).toMatch(/4 records; the limit is 3/);
    expect(w.rows('SELECT report_id FROM aggregate_reports')).toEqual([{ report_id: 'stranger.example|u1' }]);
  });

  it('an unauthenticated report has the lowest records cap', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT: '2' });
    const m = await send(w, manyRecords('a-corp.com', 'un3', 3));
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(m.setReject.mock.calls[0][0]).toMatch(/3 records; the limit is 2/);
    expect((await send(w, manyRecords('a-corp.com', 'un2', 2))).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(2);
  });

  it('IP enrichment: a counted reporter gets the normal budget, an unknown one a smaller budget, an unauthenticated report none', async () => {
    const lookups = async (kind: 'counted' | 'unknown' | 'unauth') => {
      const w = await twoWorkspaces({ INTAKE_MAX_NEW_IPS_PER_REPORT: '4', INTAKE_MAX_UNKNOWN_NEW_IPS_PER_REPORT: '2' });
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ Status: 3 })));
      vi.stubGlobal('fetch', fetchSpy);
      if (kind === 'counted') await send(w, manyRecords('a-corp.com', 'e', 6), GOOGLE);
      else if (kind === 'unauth') await send(w, manyRecords('a-corp.com', 'e', 6));
      else await sendUnknownXml(w, 'stranger.example', manyRecords('a-corp.com', 'e', 6, 'stranger.example'));
      expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(6);
      return fetchSpy.mock.calls.length;
    };
    const counted = await lookups('counted'), unknown = await lookups('unknown'), unauth = await lookups('unauth');
    expect(unauth).toBe(0);
    expect(unknown).toBeGreaterThan(0);
    expect(counted).toBe(unknown * 2);
  });
});

describe('the intake allowance: junk cannot exhaust genuine reports', () => {
  const GRPT = (w: W, id: string, o: Parameters<typeof fakeMessage>[2] = GOOGLE) => send(w, dmarcXml('a-corp.com', id), o);
  const usage = (w: W) => w.rows('SELECT reporter, reports FROM intake_usage ORDER BY reporter');

  it('junk fills its own bucket (reports), then a counted google report is still stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '3' });
    for (let i = 0; i < 3; i++) expect((await send(w, dmarcXml('a-corp.com', 'junk' + i), { from: 'x@spam.example' })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'junk-over'), { from: 'x@spam.example' });
    expect(over.setReject).toHaveBeenCalledOnce();
    expect(over.setReject.mock.calls[0][0]).toMatch(/Daily intake limit/);
    const g = await GRPT(w, 'genuine');
    expect(g.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT report_id, reporter_auth, reporter_auth_domain, reporter_tier FROM aggregate_reports WHERE report_id = 'google|genuine'")).toEqual([{ report_id: 'google|genuine', reporter_auth: 'pass', reporter_auth_domain: 'google.com', reporter_tier: 'counted' }]);
    expect(usage(w)).toEqual([{ reporter: 'google', reports: 1 }, { reporter: '~spam.example', reports: 3 }]);
  });

  it('junk fills its bucket by bytes, then a counted google report is still stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_BYTES_PER_DAY: '1000' });
    expect((await send(w, dmarcXml('a-corp.com', 'j1'), { rawSize: 900, from: 'x@spam.example' })).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'j2'), { rawSize: 200, from: 'x@spam.example' })).setReject).toHaveBeenCalledOnce();
    expect((await GRPT(w, 'genuine', { ...GOOGLE, rawSize: 1_500_000 })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['~unauth|j1', 'google|genuine']);
  });

  it('a registry reporter at its own cap does not block another registry reporter', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (const id of ['g1', 'g2', 'g3']) expect((await GRPT(w, id)).setReject).not.toHaveBeenCalled(); // g3 accepted and dropped
    expect((await sendMs(w, 'm1')).setReject).not.toHaveBeenCalled();
    expect(usage(w)).toEqual([{ reporter: 'google', reports: 2 }, { reporter: 'microsoft', reports: 1 }]);
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['google|g1', 'google|g2', 'microsoft|m1']);
    expect(dropped(w)).toEqual([{ reason: 'over_cap_accepted_dropped', messages: 1 }]);
  });

  it('unknown authenticated reporters: each has a small allowance of its own (refused beyond it) and they share one total per address', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY: '2', INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY: '3' });
    expect((await sendUnknown(w, 'busy.example', 'b1')).setReject).not.toHaveBeenCalled();
    expect((await sendUnknown(w, 'busy.example', 'b2')).setReject).not.toHaveBeenCalled();
    const own = await sendUnknown(w, 'busy.example', 'b3');
    expect(own.setReject).toHaveBeenCalledOnce();
    expect(own.setReject.mock.calls[0][0]).toMatch(/Daily intake limit for this sender/);
    expect((await sendUnknown(w, 'quiet.example', 'q1')).setReject).not.toHaveBeenCalled(); // 3rd of the total (b3 gave its place back)
    const total = await sendUnknown(w, 'newcomer.example', 'n1');
    expect(total.setReject).toHaveBeenCalledOnce();
    expect(total.setReject.mock.calls[0][0]).toMatch(/senders this service does not know/);
    expect(usage(w)).toEqual([{ reporter: 'busy.example', reports: 2 }, { reporter: 'quiet.example', reports: 1 }]);
  });

  it('an attacker with many cheap DKIM-signing domains cannot lock registry reporters out (they are outside the unknown total)', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY: '3' });
    for (let i = 0; i < 12; i++) await sendUnknown(w, `cheap${i}.example`, 'junk' + i);
    expect(w.rows("SELECT COUNT(*) AS n FROM aggregate_reports WHERE reporter_tier = 'unknown'")).toEqual([{ n: 3 }]);
    expect((await GRPT(w, 'g1')).setReject).not.toHaveBeenCalled();
    expect((await sendMs(w, 'm1')).setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT report_id FROM aggregate_reports WHERE reporter_tier = 'counted' ORDER BY id")).toEqual([{ report_id: 'google|g1' }, { report_id: 'microsoft|m1' }]);
  });

  it('unauthenticated senders share one total per address: past it the next is refused, whoever it claims to be', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY: '2' });
    const refused: boolean[] = [];
    for (const [i, from] of ['a@one.example', 'b@two.example', 'c@three.example'].entries()) refused.push((await send(w, dmarcXml('a-corp.com', 'o' + i), { from })).setReject.mock.calls.length > 0);
    expect(refused).toEqual([false, false, true]);
    expect(usage(w)).toEqual([{ reporter: '~one.example', reports: 1 }, { reporter: '~two.example', reports: 1 }]);
    expect((await GRPT(w, 'genuine')).setReject).not.toHaveBeenCalled();
  });

  it('defaults: tight for unauthenticated mail, small for unknown reporters, unchanged for registry reporters', () => {
    expect(intakeLimits({ MODE: 'saas' })).toMatchObject({
      reportsPerDay: 50, bytesPerDay: 50 * 1024 * 1024,
      unknownReportsPerReporterPerDay: 5, unknownReportsPerDay: 20, unknownRecordsPerReport: 1000, unknownNewIpsPerReport: 10,
      unauthReportsPerDay: 5, unauthBytesPerDay: 10 * 1024 * 1024, unauthTotalReportsPerDay: 10, unauthRecordsPerReport: 200,
      nonRegistryDecompressedBytes: 1024 * 1024,
    });
  });
});

describe('AUTHSERV_* not set yet: nothing is authenticated, nothing is starved', () => {
  it('every report is accepted and stored uncounted, flagged "none" and charged to its claimed sender', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: undefined, AUTHSERV_HEADER: undefined } as any);
    expect((await send(w, dmarcXml('a-corp.com', 'u1'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'u2'), { from: 'noreply@microsoft.com' })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id, reporter_auth, reporter_tier FROM aggregate_reports ORDER BY id')).toEqual([
      { report_id: '~unauth|u1', reporter_auth: 'none', reporter_tier: 'unauthenticated' },
      { report_id: '~unauth|u2', reporter_auth: 'none', reporter_tier: 'unauthenticated' },
    ]);
    expect(w.rows("SELECT reporter FROM intake_usage WHERE reporter <> '*' ORDER BY reporter")).toEqual([{ reporter: '~google.com' }, { reporter: '~microsoft.com' }]);
  });

  it('junk claiming to be one sender leaves other senders’ reports alone', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: undefined, AUTHSERV_HEADER: undefined, INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '3' } as any);
    for (let i = 0; i < 3; i++) await send(w, dmarcXml('a-corp.com', 'junk' + i), { from: 'x@spam.example' });
    expect((await send(w, dmarcXml('a-corp.com', 'junk-over'), { from: 'x@spam.example' })).setReject).toHaveBeenCalledOnce();
    const g = await send(w, dmarcXml('a-corp.com', 'genuine'), GOOGLE);
    expect(g.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reporter_auth FROM aggregate_reports WHERE report_id = '~unauth|genuine'")).toEqual([{ reporter_auth: 'none' }]);
  });
});

describe('forged Authentication-Results cannot make a report look authenticated', () => {
  const FORGED = 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1';
  const own = (w: W, id: string, rawHeaderLines: string[]) => send(w, dmarcXml('a-corp.com', id), { rawHeaderLines });
  const stored = (w: W, id: string) => w.rows('SELECT reporter_auth, reporter_tier FROM aggregate_reports WHERE report_id = ?', '~unauth|' + id);

  it('the receiver’s topmost header decides: a forged "pass" injected BELOW the receiver’s "fail" is ignored', async () => {
    const w = await twoWorkspaces();
    await own(w, 'inj', ['Authentication-Results: mx.cloudflare.net; dkim=fail header.d=google.com', 'Authentication-Results: ' + FORGED]);
    expect(stored(w, 'inj')).toEqual([{ reporter_auth: 'fail', reporter_tier: 'unauthenticated' }]);
    expect(w.rows('SELECT reporter FROM intake_usage')).toEqual([{ reporter: '~google.com' }]);
  });

  it('a header naming another authserv-id (the sender wrote it, the receiver did not) proves nothing, wherever it sits', async () => {
    const w = await twoWorkspaces();
    await own(w, 'other', ['Authentication-Results: attacker.example; dkim=pass header.d=google.com']);
    expect(stored(w, 'other')).toEqual([{ reporter_auth: 'fail', reporter_tier: 'unauthenticated' }]);
  });

  it('a forged header with the right authserv-id and a pass for an unrelated domain does not authenticate the From organisation', async () => {
    const w = await twoWorkspaces();
    await own(w, 'wrongdom', ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=evil.example']);
    expect(stored(w, 'wrongdom')).toEqual([{ reporter_auth: 'fail', reporter_tier: 'unauthenticated' }]);
  });

  it('junk with forged results cannot use up google’s counted allowance: the forged header is not on top', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (let i = 0; i < 5; i++) await send(w, dmarcXml('a-corp.com', 'forged' + i), { rawHeaderLines: ['Authentication-Results: mx.cloudflare.net; dkim=none', 'Authentication-Results: ' + FORGED] });
    expect((await send(w, dmarcXml('a-corp.com', 'genuine'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reports FROM intake_usage WHERE reporter = 'google'")).toEqual([{ reports: 1 }]);
    expect(w.rows("SELECT report_id FROM aggregate_reports WHERE reporter_tier = 'counted'")).toEqual([{ report_id: 'google|genuine' }]);
  });

  it('an uncounted report neither squats nor displaces a real reporter’s report id', async () => {
    const w = await twoWorkspaces();
    const forged = { rawHeaderLines: ['Authentication-Results: attacker.example; dkim=pass header.d=google.com'] };
    // forged first: google's report with the same id is still stored, and replaces the uncounted one
    await send(w, dmarcXml('a-corp.com', 'same-id'), forged);
    expect(w.rows('SELECT report_id, reporter_tier FROM aggregate_reports')).toEqual([{ report_id: '~unauth|same-id', reporter_tier: 'unauthenticated' }]);
    expect((await send(w, dmarcXml('a-corp.com', 'same-id'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id, reporter_tier FROM aggregate_reports')).toEqual([{ report_id: 'google|same-id', reporter_tier: 'counted' }]);
    // google first: a later uncounted report with that id is a duplicate (not stored), the counted one is untouched
    await send(w, dmarcXml('a-corp.com', 'same-id'), forged);
    expect(w.rows('SELECT report_id, reporter_tier FROM aggregate_reports ORDER BY id')).toEqual([{ report_id: 'google|same-id', reporter_tier: 'counted' }]);
  });
});

describe('policy_published must be the token’s domain or a subdomain', () => {
  const filed = (w: Awaited<ReturnType<typeof twoWorkspaces>>) => w.rows('SELECT domain_id, report_id FROM aggregate_reports ORDER BY id');

  it('rejects another domain of the same workspace, a parent, a look-alike suffix and another workspace’s domain', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_a', 'other-a.com', 'x')").run();
    for (const d of ['other-a.com', 'corp.com', 'evila-corp.com', 'a-corp.com.evil.io', 'b-corp.org']) expect((await send(w, dmarcXml(d, 'x-' + d), GOOGLE)).setReject, d).toHaveBeenCalledOnce();
    expect(filed(w)).toEqual([]);
  });

  it('files a subdomain under the token’s domain', async () => {
    const w = await twoWorkspaces();
    expect((await send(w, dmarcXml('mail.a-corp.com', 'sub-1'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(filed(w)).toEqual([{ domain_id: 1, report_id: 'google|sub-1' }]);
  });

  it('files a subdomain under its own row when it is a verified domain of the same workspace', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (3, 'ws_a', 'mail.a-corp.com', 'x', 'txt')").run(); // proven: an unproven (legacy) row never receives reports
    expect((await send(w, dmarcXml('mail.a-corp.com', 'sub-2'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(filed(w)).toEqual([{ domain_id: 3, report_id: 'google|sub-2' }]);
  });

  it('does not use a subdomain verified in a different workspace', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_b', 'mail.a-corp.com', 'x')").run();
    expect((await send(w, dmarcXml('mail.a-corp.com', 'sub-3'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT a.domain_id, d.workspace_id FROM aggregate_reports a JOIN domains d ON d.id = a.domain_id')).toEqual([{ domain_id: 1, workspace_id: 'ws_a' }]);
  });
});

describe('reporter_auth, reporter_tier and the tier decision', () => {
  const AR = (s: string) => ({ headers: { 'authentication-results': s } });
  const stored = (w: W) => w.rows('SELECT report_id, reporter_auth, reporter_auth_domain, reporter_auth_reason, reporter_tier FROM aggregate_reports ORDER BY id');

  it('an aligned DKIM pass for a registry reporter counts; a DMARC pass alone is authenticated but unknown; SPF alone proves nothing; no header is "none"', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'k'), AR('mx.cloudflare.net; dkim=pass header.d=mail.google.com header.s=s1'));
    await send(w, dmarcXml('a-corp.com', 's'), AR('mx.cloudflare.net; dkim=fail header.d=google.com; spf=pass smtp.mailfrom=bounce@google.com'));
    await send(w, dmarcXml('a-corp.com', 'f1'), AR('mx.cloudflare.net; dkim=pass header.d=evil.com; spf=pass smtp.mailfrom=x@evil.com; dmarc=fail header.from=google.com'));
    await send(w, dmarcXml('a-corp.com', 'f2'), AR('mx.cloudflare.net; dkim=fail header.d=google.com; spf=softfail smtp.mailfrom=x@google.com'));
    await send(w, dmarcXml('a-corp.com', 'd'), AR('mx.cloudflare.net; dmarc=pass header.from=google.com'));
    await send(w, dmarcXml('a-corp.com', 'n'));
    expect(stored(w)).toEqual([
      { report_id: 'google|k', reporter_auth: 'pass', reporter_auth_domain: 'google.com', reporter_auth_reason: null, reporter_tier: 'counted' },
      { report_id: '~unauth|s', reporter_auth: 'fail', reporter_auth_domain: null, reporter_auth_reason: 'not_authenticated', reporter_tier: 'unauthenticated' },
      { report_id: '~unauth|f1', reporter_auth: 'fail', reporter_auth_domain: null, reporter_auth_reason: 'not_authenticated', reporter_tier: 'unauthenticated' },
      { report_id: '~unauth|f2', reporter_auth: 'fail', reporter_auth_domain: null, reporter_auth_reason: 'not_authenticated', reporter_tier: 'unauthenticated' },
      { report_id: 'google.com|d', reporter_auth: 'pass', reporter_auth_domain: 'google.com', reporter_auth_reason: 'not_in_registry', reporter_tier: 'unknown' },
      { report_id: '~unauth|n', reporter_auth: 'none', reporter_auth_domain: null, reporter_auth_reason: 'no_authentication_results', reporter_tier: 'unauthenticated' },
    ]);
  });

  it('a registry carrier whose report email is not an accepted one is stored as unknown, never counted (a changed identity is not silently trusted)', async () => {
    const w = await twoWorkspaces();
    const xml = dmarcXml('a-corp.com', 'drift').replace('noreply-dmarc-support@google.com', 'someone-else@google.com');
    expect((await send(w, xml, AR('mx.cloudflare.net; dkim=pass header.d=google.com'))).setReject).not.toHaveBeenCalled();
    expect(stored(w)).toEqual([{ report_id: 'google|drift', reporter_auth: 'pass', reporter_auth_domain: 'google.com', reporter_auth_reason: 'registry_email_not_accepted', reporter_tier: 'unknown' }]);
  });

  it('is exposed by the reports queries (so the list/detail API carries it)', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'q'), AR('mx.cloudflare.net; dkim=pass header.d=google.com'));
    const { forWorkspace } = await import('@ready-set-mail/db');
    expect((await forWorkspace(w.env.DB, 'ws_a').reports.recent())[0]).toMatchObject({ reporter_auth: 'pass', reporter_auth_domain: 'google.com' });
    expect(await forWorkspace(w.env.DB, 'ws_a').reports.getWithDomain(1)).toMatchObject({ reporter_auth: 'pass' });
  });

  it('decideTier: the report email decides, org_name never does; unknown needs a self-consistent identity, else unauthenticated', () => {
    const env = { AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };
    const carrier = (ar: string, from = 'noreply-dmarc-support@google.com') => carrierFromHeaders({ ar, arc: null, from }, env);
    const google = carrier('mx.cloudflare.net; dkim=pass header.d=google.com');
    expect(google.class).toBe('registry');
    expect(decideTier(google, { email: 'noreply-dmarc-support@google.com' })).toMatchObject({ tier: 'counted', identity: 'google', knownAs: 'Google', auth: 'pass' });
    expect(decideTier(google, { email: '' })).toMatchObject({ tier: 'unknown', identity: 'google', reason: 'registry_email_not_accepted' });
    const stranger = carrier('mx.cloudflare.net; dkim=pass header.d=example.org', 'a@example.org');
    expect(stranger.class).toBe('authenticated');
    expect(decideTier(stranger, { email: 'a@example.org' })).toMatchObject({ tier: 'unknown', identity: 'example.org', reason: 'not_in_registry' });
    expect(decideTier(stranger, { email: null })).toMatchObject({ tier: 'unauthenticated', identity: '~unauth', reason: 'inconsistent_identity' });
    expect(decideTier(stranger, { email: 'a@someone-else.net' })).toMatchObject({ tier: 'unauthenticated', reason: 'inconsistent_identity' });
  });

  it('fails closed without AUTHSERV_ID / AUTHSERV_HEADER: unauthenticated, auth "none"', () => {
    const h = { ar: 'mx.cloudflare.net; dkim=pass header.d=yahoo.com', arc: null, from: 'noreply@dmarc.yahoo.com' };
    for (const env of [{}, { AUTHSERV_ID: 'mx.cloudflare.net' }]) {
      const c = carrierFromHeaders(h, env);
      expect(c).toMatchObject({ class: 'unauthenticated', authenticated: false, reason: 'authserv_unconfigured', presence: 'unconfigured' });
      expect(decideTier(c, { email: 'dmarchelp@yahooinc.com' })).toMatchObject({ tier: 'unauthenticated', auth: 'none' });
    }
    // with both set, the same headers are the registry's Yahoo (relaxed alignment: From noreply@dmarc.yahoo.com, d=yahoo.com)
    expect(carrierFromHeaders(h, { AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' }).class).toBe('registry');
  });
});

describe('hosted domains per workspace', () => {
  const resolver = dnsFrom({});
  it('refuses beyond the cap with a 429 and counts each workspace on its own', async () => {
    const w = await twoWorkspaces();
    stubCloudflare(new FakeCloudflare({ 'readysetmail.com': { id: 'zone-h' } }));
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_a', 'a2-corp.com', 'x')").run();
    const env = { ...HOSTED_ENV, HOSTED_MAX_DOMAINS_PER_WORKSPACE: '1' } as any;
    const tenant = (ws: string) => makeTenant({ db: w.db, workspaceId: ws, env });
    const domain = async (ws: string, id: number) => (await tenant(ws).scope.domains.getById(id))!;
    const spf = { spfRecord: 'v=spf1 ~all' };

    await enableHosted(tenant('ws_a'), await domain('ws_a', 1), spf, { resolver });
    await expect(enableHosted(tenant('ws_a'), await domain('ws_a', 3), spf, { resolver })).rejects.toMatchObject({ status: 429 });
    expect(w.rows('SELECT domain_id FROM hosted_domains')).toEqual([{ domain_id: 1 }]);
    await enableHosted(tenant('ws_b'), await domain('ws_b', 2), spf, { resolver }); // ws_a being full does not touch ws_b
    expect(w.rows('SELECT workspace_id FROM hosted_domains ORDER BY domain_id')).toEqual([{ workspace_id: 'ws_a' }, { workspace_id: 'ws_b' }]);
  });
});

describe('self-host decompression bombs', () => {
  function selfHost() {
    const db = createMigratedD1();
    db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id) VALUES (1, 'acme.com', 'rua@reports.acme.com', 'ws_default')").run();
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'base_domain', 'acme.com')").run();
    const env = makeEnv(db, {}) as any;
    return { env, rows: (sql: string) => db.sqlite.prepare(sql).all() as any[] };
  }
  const bomb = strToU8('<?xml version="1.0"?><feedback>' + ' '.repeat(26 * 1024 * 1024) + '</feedback>');

  it.each([
    ['gzip', () => mimeWithAttachment(gzipSync(bomb), 'r.xml.gz', 'application/gzip')],
    ['zip', () => mimeWithAttachment(zipSync({ 'r.xml': bomb }), 'r.zip', 'application/zip')],
  ])('a small %s that inflates past 25 MiB is rejected and nothing is stored', async (_n, mime) => {
    const s = selfHost();
    const m = fakeMessage('rua@reports.acme.com', mime());
    expect(m.rawSize).toBeLessThan(200_000);
    await worker.email(m, s.env, ctx);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(m.setReject.mock.calls[0][0]).toBe('Report is too large once decompressed');
    expect(s.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('an ordinary zipped report still files', async () => {
    const s = selfHost();
    const m = fakeMessage('rua@reports.acme.com', zipReportMime(dmarcXml('acme.com', 'ok-1')));
    await worker.email(m, s.env, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(s.rows('SELECT report_id FROM aggregate_reports')).toEqual([{ report_id: '~unauth|ok-1' }]); // self-host has no AUTHSERV_*: stored uncounted
  });
});

describe('a token’s daily totals survive reporters coming and going', () => {
  const quota = (w: W, scope: string) => w.rows('SELECT messages, bytes FROM intake_quota WHERE scope = ?', scope);

  it('many cheap authenticated domains cannot each bring a fresh allowance: the address’s unknown total holds', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY: '5', INTAKE_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY: '10' });
    const accepted: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m = await sendUnknown(w, `cheap${i % 4}.example`, `r${i}`);
      if (!m.setReject.mock.calls.length) accepted.push(`r${i}`);
    }
    expect(accepted).toHaveLength(5); // the total, not 12 messages × fresh allowances
    expect(quota(w, 'k:1')).toEqual([expect.objectContaining({ messages: 5 })]);
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports')).toEqual([{ n: 5 }]);
  });

  it('bytes are counted per reporter, and a refused message gives back what it counted in the address totals', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_BYTES_PER_DAY: '1000' });
    expect((await sendUnknown(w, 'one.example', 'b1', { rawSize: 800 })).setReject).not.toHaveBeenCalled();
    expect((await sendUnknown(w, 'one.example', 'b2', { rawSize: 800 })).setReject).toHaveBeenCalledOnce();
    expect(w.rows("SELECT reporter, reports, bytes FROM intake_usage WHERE reporter = 'one.example'")).toEqual([{ reporter: 'one.example', reports: 1, bytes: 800 }]);
    expect(quota(w, 'k:1')).toEqual([{ messages: 1, bytes: 800 }]);
    expect(quota(w, 'a:1')).toEqual([]); // uncounted mail is not charged to the counted address counter
    expect(quota(w, 'n:ws_a')).toEqual([{ messages: 1, bytes: 800 }]);
  });

  it('registry reporters are outside the unknown total: junk reporters exhausting it cannot block google', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY: '2' });
    for (let i = 0; i < 4; i++) await sendUnknown(w, `cheap${i}.example`, 'j' + i);
    expect((await send(w, dmarcXml('a-corp.com', 'g1'), dkimHdr('google.com'))).setReject).not.toHaveBeenCalled();
    expect(quota(w, 'k:1')).toEqual([expect.objectContaining({ messages: 2 })]);
    expect(w.rows("SELECT report_id FROM aggregate_reports WHERE reporter_tier = 'counted'")).toEqual([{ report_id: 'google|g1' }]);
  });

  it('defaults', () => {
    expect(intakeLimits({})).toMatchObject({ addressMessagesPerDay: 500, workspaceMessagesPerDay: 2000, instanceMessagesPerDay: 50_000, unknownReportsPerDay: 20, unauthTotalReportsPerDay: 10 });
  });
});
