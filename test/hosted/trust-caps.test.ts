// Trust hardening on the hosted intake: per-token caps, exact policy_published, reporter authentication,
// the per-workspace hosted-domain cap, and the zip/gzip bomb cap in self-host.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { gzipSync, zipSync, strToU8 } from 'fflate';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { resetSchemaReadyCache } from '@inbox-angel/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { handleHostedEmail } from '../../src/hosted/intake';
import { enableHosted } from '../../src/hosted/service';
import { intakeLimits, DEFAULT_MAX_REPORTS_PER_DAY, DEFAULT_MAX_RECORDS_PER_REPORT, DEFAULT_MAX_BYTES_PER_DAY } from '../../src/hosted/config';
import { reporterAuth } from '../../src/dmarc/reporter-auth';
import { makeEnv } from '../auth/helpers';
import { makeTenant } from '../helpers/tenant';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment, zipReportMime } from '../helpers/mail';
import { dnsFrom } from './dns';
import { HOSTED_ENV, nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.inboxangel.io';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const send = async (w: Awaited<ReturnType<typeof twoWorkspaces>>, xml: string, o: Parameters<typeof fakeMessage>[2] = {}) => {
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(xml), o);
  await handleHostedEmail(m, w.env);
  return m;
};

function manyRecords(domain: string, reportId: string, n: number): string {
  const rec = (i: number) => `<record><row><source_ip>198.51.${Math.floor(i / 250)}.${i % 250 + 1}</source_ip><count>1</count>
    <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers></record>`;
  const base = dmarcXml(domain, reportId);
  return base.replace(/<record>[\s\S]*<\/record>/, Array.from({ length: n }, (_, i) => rec(i)).join('\n'));
}

describe('defaults and env overrides', () => {
  it('have sane defaults; bad values fall back', () => {
    expect(intakeLimits({})).toMatchObject({ reportsPerDay: DEFAULT_MAX_REPORTS_PER_DAY, recordsPerReport: DEFAULT_MAX_RECORDS_PER_REPORT, bytesPerDay: DEFAULT_MAX_BYTES_PER_DAY });
    expect(intakeLimits({ INTAKE_MAX_REPORTS_PER_DAY: '7', INTAKE_MAX_RECORDS_PER_REPORT: 'x', INTAKE_MAX_BYTES_PER_DAY: '-1' })).toMatchObject({ reportsPerDay: 7, recordsPerReport: DEFAULT_MAX_RECORDS_PER_REPORT, bytesPerDay: DEFAULT_MAX_BYTES_PER_DAY });
  });
});

describe('per-token caps', () => {
  it('reports per day: the next one is rejected, stores nothing, and the other workspace is unaffected', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (const id of ['r1', 'r2']) expect((await send(w, dmarcXml('a-corp.com', id), GOOGLE)).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'r3'), GOOGLE);
    expect(over.setReject).toHaveBeenCalledOnce();
    expect(over.setReject.mock.calls[0][0]).toMatch(/Daily intake limit/);
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['r1', 'r2']);
    expect(w.rows('SELECT domain_id, workspace_id, reporter, reports FROM intake_usage')).toEqual([{ domain_id: 1, workspace_id: 'ws_a', reporter: 'google.com', reports: 2 }]);

    const b = fakeMessage(`rua+${w.tokenB}@${RUA}`, gzipReportMime(dmarcXml('b-corp.org', 'rb')), GOOGLE);
    await handleHostedEmail(b, w.env);
    expect(b.setReject).not.toHaveBeenCalled();
  });

  it('a new UTC day starts a new allowance', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T23:00:00Z'));
      expect((await send(w, dmarcXml('a-corp.com', 'd1'), GOOGLE)).setReject).not.toHaveBeenCalled();
      expect((await send(w, dmarcXml('a-corp.com', 'd1b'), GOOGLE)).setReject).toHaveBeenCalledOnce();
      vi.setSystemTime(new Date('2030-01-02T00:01:00Z'));
      expect((await send(w, dmarcXml('a-corp.com', 'd2'), GOOGLE)).setReject).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('bytes per day: counted from the raw message size, refused when they would exceed the cap', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_BYTES_PER_DAY: '1000' });
    expect((await send(w, dmarcXml('a-corp.com', 'b1'), { ...GOOGLE, rawSize: 600 })).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'b2'), { ...GOOGLE, rawSize: 600 })).setReject).toHaveBeenCalledOnce();
    expect((await send(w, dmarcXml('a-corp.com', 'b3'), { ...GOOGLE, rawSize: 400 })).setReject).not.toHaveBeenCalled(); // exactly the cap
    expect((await send(w, dmarcXml('a-corp.com', 'b4'), { ...GOOGLE, rawSize: 1 })).setReject).toHaveBeenCalledOnce();
    expect(w.rows('SELECT reports, bytes FROM intake_usage')).toEqual([{ reports: 2, bytes: 1000 }]);
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['b1', 'b3']);
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

    expect((await send(w, manyRecords('a-corp.com', 'ok', 5))).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(5);
  });

  it('new-IP enrichment is capped per message but every record is still stored', async () => {
    const run = async (cap: string) => {
      const w = await twoWorkspaces({ INTAKE_MAX_NEW_IPS_PER_REPORT: cap });
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ Status: 3 })));
      vi.stubGlobal('fetch', fetchSpy);
      expect((await send(w, manyRecords('a-corp.com', 'ips', 6))).setReject).not.toHaveBeenCalled();
      expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(6);
      return fetchSpy.mock.calls.length;
    };
    const one = await run('1');
    const three = await run('3');
    expect(one).toBeGreaterThan(0);
    expect(three).toBe(one * 3);
  });
});

describe('the intake allowance: junk cannot exhaust genuine reports', () => {
  const MS = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=microsoft.com header.s=s1' } };
  const GRPT = (w: Awaited<ReturnType<typeof twoWorkspaces>>, id: string, o: Parameters<typeof fakeMessage>[2] = GOOGLE) => send(w, dmarcXml('a-corp.com', id), o);
  const usage = (w: Awaited<ReturnType<typeof twoWorkspaces>>) => w.rows("SELECT reporter, reports FROM intake_usage WHERE reporter <> '*' ORDER BY reporter");

  it('junk fills its own bucket (reports), then a proven google.com report is still stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '3' });
    for (let i = 0; i < 3; i++) expect((await send(w, dmarcXml('a-corp.com', 'junk' + i), { from: 'x@spam.example' })).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'junk-over'), { from: 'x@spam.example' });
    expect(over.setReject).toHaveBeenCalledOnce();
    expect(over.setReject.mock.calls[0][0]).toMatch(/Daily intake limit/);
    const g = await GRPT(w, 'genuine');
    expect(g.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT report_id, reporter_auth, reporter_auth_domain FROM aggregate_reports WHERE report_id = 'genuine'")).toEqual([{ report_id: 'genuine', reporter_auth: 'pass', reporter_auth_domain: 'google.com' }]);
    expect(usage(w)).toEqual([{ reporter: 'google.com', reports: 1 }, { reporter: '~spam.example', reports: 3 }]);
  });

  it('junk fills its bucket by bytes, then a proven google.com report is still stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_BYTES_PER_DAY: '1000' });
    expect((await send(w, dmarcXml('a-corp.com', 'j1'), { rawSize: 900, from: 'x@spam.example' })).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'j2'), { rawSize: 200, from: 'x@spam.example' })).setReject).toHaveBeenCalledOnce();
    expect((await GRPT(w, 'genuine', { ...GOOGLE, rawSize: 5_000_000 })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['j1', 'genuine']);
  });

  it('a reporter at its own cap does not block another proven reporter', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (const id of ['g1', 'g2']) expect((await GRPT(w, id)).setReject).not.toHaveBeenCalled();
    expect((await GRPT(w, 'g3')).setReject).toHaveBeenCalledOnce();
    expect((await GRPT(w, 'm1', MS)).setReject).not.toHaveBeenCalled();
    expect(usage(w)).toEqual([{ reporter: 'google.com', reports: 2 }, { reporter: 'microsoft.com', reports: 1 }]);
  });

  it('slots for unknown proven reporters: when full, the least-used one makes room instead of a new one being refused', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTERS_PER_DAY: '2' });
    const dkim = (d: string) => ({ headers: { 'authentication-results': `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1` } });
    const org = (d: string, id: string) => send(w, dmarcXml('a-corp.com', id, d), dkim(d));
    await org('busy.example', 'b1'); await org('busy.example', 'b2'); await org('busy.example', 'b3');
    await org('quiet.example', 'q1');
    expect((await org('newcomer.example', 'n1')).setReject).not.toHaveBeenCalled(); // not refused
    expect(usage(w)).toEqual([{ reporter: 'busy.example', reports: 3 }, { reporter: 'newcomer.example', reports: 1 }]); // quiet.example (least used) made room
  });

  it('well-known reporters are never refused for want of a slot, and do not use one', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTERS_PER_DAY: '1' });
    const dkim = (d: string) => ({ headers: { 'authentication-results': `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1` } });
    await send(w, dmarcXml('a-corp.com', 'u1', 'cheap1.example'), dkim('cheap1.example'));
    for (const d of ['google.com', 'yahoo.com', 'microsoft.com', 'outlook.com']) expect((await send(w, dmarcXml('a-corp.com', 'k-' + d, d), dkim(d))).setReject, d).not.toHaveBeenCalled();
    expect(usage(w).map(r => r.reporter)).toEqual(['cheap1.example', 'google.com', 'microsoft.com', 'outlook.com', 'yahoo.com']);
  });

  it('an attacker with many cheap DKIM-signing domains cannot lock genuine reporters out', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTERS_PER_DAY: '3' });
    const dkim = (d: string) => ({ headers: { 'authentication-results': `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1` } });
    for (let i = 0; i < 12; i++) await send(w, dmarcXml('a-corp.com', 'junk' + i, `cheap${i}.example`), dkim(`cheap${i}.example`));
    expect((await send(w, dmarcXml('a-corp.com', 'g1', 'google.com'), dkim('google.com'))).setReject).not.toHaveBeenCalled(); // well known
    expect((await send(w, dmarcXml('a-corp.com', 'small1', 'smallorg.example'), dkim('smallorg.example'))).setReject).not.toHaveBeenCalled(); // unknown but genuine
    expect(w.rows("SELECT report_id FROM aggregate_reports WHERE report_id IN ('g1', 'small1') ORDER BY id").length).toBe(2);
  });

  it('unproven senders past the slot limit share one overflow bucket instead of being refused', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_SENDERS_PER_DAY: '1' });
    for (const [i, from] of ['a@one.example', 'b@two.example', 'c@three.example'].entries()) expect((await send(w, dmarcXml('a-corp.com', 'o' + i), { from })).setReject).not.toHaveBeenCalled();
    expect(usage(w)).toEqual([{ reporter: '~', reports: 2 }, { reporter: '~one.example', reports: 1 }]);
  });

  it('defaults are generous for unproven senders (per claimed sender domain), tight for nobody who is proven', () => {
    expect(intakeLimits({})).toMatchObject({ reportsPerDay: 50, bytesPerDay: 50 * 1024 * 1024, reportersPerDay: 100, unauthReportsPerDay: 200, unauthBytesPerDay: 1024 * 1024 * 1024, unauthSendersPerDay: 50 });
  });
});

describe('AUTHSERV_* not set yet: nothing is proven, nothing is starved', () => {
  it('every report is accepted, flagged "none" and charged to its claimed sender; one spoofed sender cannot take another’s bucket on its first messages', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: undefined, AUTHSERV_HEADER: undefined } as any);
    expect((await send(w, dmarcXml('a-corp.com', 'u1'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'u2'), { from: 'noreply@microsoft.com' })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter_auth FROM aggregate_reports ORDER BY id')).toEqual([{ reporter_auth: 'none' }, { reporter_auth: 'none' }]);
    expect(w.rows("SELECT reporter FROM intake_usage WHERE reporter <> '*' ORDER BY reporter")).toEqual([{ reporter: '~google.com' }, { reporter: '~microsoft.com' }]);
  });

  it('junk claiming to be one sender (200 messages needed at the default) leaves other senders’ genuine reports alone', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: undefined, AUTHSERV_HEADER: undefined, INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '3' } as any);
    for (let i = 0; i < 3; i++) await send(w, dmarcXml('a-corp.com', 'junk' + i), { from: 'x@spam.example' });
    expect((await send(w, dmarcXml('a-corp.com', 'junk-over'), { from: 'x@spam.example' })).setReject).toHaveBeenCalledOnce();
    const g = await send(w, dmarcXml('a-corp.com', 'genuine'), GOOGLE);
    expect(g.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reporter_auth FROM aggregate_reports WHERE report_id = 'genuine'")).toEqual([{ reporter_auth: 'none' }]);
  });
});

describe('forged Authentication-Results cannot make a report look authenticated', () => {
  const FORGED = 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1';
  const own = (w: Awaited<ReturnType<typeof twoWorkspaces>>, id: string, rawHeaderLines: string[]) => send(w, dmarcXml('a-corp.com', id), { rawHeaderLines });
  const stored = (w: Awaited<ReturnType<typeof twoWorkspaces>>, id: string) => w.rows('SELECT reporter_auth FROM aggregate_reports WHERE report_id = ?', id);

  it('the receiver’s topmost header decides: a forged "pass" injected BELOW the receiver’s "fail" is ignored', async () => {
    const w = await twoWorkspaces();
    await own(w, 'inj', ['Authentication-Results: mx.cloudflare.net; dkim=fail header.d=google.com', 'Authentication-Results: ' + FORGED]);
    expect(stored(w, 'inj')).toEqual([{ reporter_auth: 'fail' }]);
    expect(w.rows('SELECT reporter FROM intake_usage')).toEqual([{ reporter: '~google.com' }]);
  });

  it('a header naming another authserv-id (the sender wrote it, the receiver did not) proves nothing, wherever it sits', async () => {
    const w = await twoWorkspaces();
    await own(w, 'other', ['Authentication-Results: attacker.example; dkim=pass header.d=google.com']);
    expect(stored(w, 'other')).toEqual([{ reporter_auth: 'fail' }]);
  });

  it('a forged header with the right authserv-id and a pass for an unrelated domain does not prove the claimed organisation', async () => {
    const w = await twoWorkspaces();
    await own(w, 'wrongdom', ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=evil.example']);
    expect(stored(w, 'wrongdom')).toEqual([{ reporter_auth: 'fail' }]);
  });

  it('junk with forged results cannot use up google.com’s proven allowance: the forged header is not on top', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (let i = 0; i < 5; i++) await send(w, dmarcXml('a-corp.com', 'forged' + i), { rawHeaderLines: ['Authentication-Results: mx.cloudflare.net; dkim=none', 'Authentication-Results: ' + FORGED] });
    expect((await send(w, dmarcXml('a-corp.com', 'genuine'), GOOGLE)).setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reports FROM intake_usage WHERE reporter = 'google.com'")).toEqual([{ reports: 1 }]);
  });
});

describe('policy_published must be the token’s domain or a subdomain', () => {
  const filed = (w: Awaited<ReturnType<typeof twoWorkspaces>>) => w.rows('SELECT domain_id, report_id FROM aggregate_reports ORDER BY id');

  it('rejects another domain of the same workspace, a parent, a look-alike suffix and another workspace’s domain', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_a', 'other-a.com', 'x')").run();
    for (const d of ['other-a.com', 'corp.com', 'evila-corp.com', 'a-corp.com.evil.io', 'b-corp.org']) expect((await send(w, dmarcXml(d, 'x-' + d))).setReject, d).toHaveBeenCalledOnce();
    expect(filed(w)).toEqual([]);
  });

  it('files a subdomain under the token’s domain', async () => {
    const w = await twoWorkspaces();
    expect((await send(w, dmarcXml('mail.a-corp.com', 'sub-1'))).setReject).not.toHaveBeenCalled();
    expect(filed(w)).toEqual([{ domain_id: 1, report_id: 'sub-1' }]);
  });

  it('files a subdomain under its own row when it is a verified domain of the same workspace', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_a', 'mail.a-corp.com', 'x')").run();
    expect((await send(w, dmarcXml('mail.a-corp.com', 'sub-2'))).setReject).not.toHaveBeenCalled();
    expect(filed(w)).toEqual([{ domain_id: 3, report_id: 'sub-2' }]);
  });

  it('does not use a subdomain verified in a different workspace', async () => {
    const w = await twoWorkspaces();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (3, 'ws_b', 'mail.a-corp.com', 'x')").run();
    expect((await send(w, dmarcXml('mail.a-corp.com', 'sub-3'))).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT a.domain_id, d.workspace_id FROM aggregate_reports a JOIN domains d ON d.id = a.domain_id')).toEqual([{ domain_id: 1, workspace_id: 'ws_a' }]);
  });
});

describe('reporter_auth', () => {
  const AR = (s: string) => ({ headers: { 'authentication-results': s } });
  const stored = (w: Awaited<ReturnType<typeof twoWorkspaces>>) => w.rows('SELECT reporter_auth, reporter_auth_domain FROM aggregate_reports ORDER BY id');

  it('pass on an aligned DKIM or DMARC pass from the receiver; fail otherwise (SPF alone proves nothing); none without a header', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'k'), AR('mx.cloudflare.net; dkim=pass header.d=mail.google.com header.s=s1'));
    await send(w, dmarcXml('a-corp.com', 's'), AR('mx.cloudflare.net; dkim=fail header.d=google.com; spf=pass smtp.mailfrom=bounce@google.com'));
    await send(w, dmarcXml('a-corp.com', 'f1'), AR('mx.cloudflare.net; dkim=pass header.d=evil.com; spf=pass smtp.mailfrom=x@evil.com; dmarc=fail header.from=google.com'));
    await send(w, dmarcXml('a-corp.com', 'f2'), AR('mx.cloudflare.net; dkim=fail header.d=google.com; spf=softfail smtp.mailfrom=x@google.com'));
    await send(w, dmarcXml('a-corp.com', 'd'), AR('mx.cloudflare.net; dmarc=pass header.from=google.com'));
    await send(w, dmarcXml('a-corp.com', 'n'));
    expect(stored(w)).toEqual([
      { reporter_auth: 'pass', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'fail', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'fail', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'fail', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'pass', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'none', reporter_auth_domain: 'google.com' },
    ]);
  });

  it('is exposed by the reports queries (so the list/detail API carries it)', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'q'), AR('mx.cloudflare.net; dkim=pass header.d=google.com'));
    const { forWorkspace } = await import('@inbox-angel/db');
    expect((await forWorkspace(w.env.DB, 'ws_a').reports.recent())[0]).toMatchObject({ reporter_auth: 'pass', reporter_auth_domain: 'google.com' });
    expect(await forWorkspace(w.env.DB, 'ws_a').reports.getWithDomain(1)).toMatchObject({ reporter_auth: 'pass' });
  });

  it('uses the org name when the email is absent, and fails when the org is unknowable', () => {
    const h = { ar: 'mx.cloudflare.net; dkim=pass header.d=yahoo.com', arc: null };
    const env = { AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };
    expect(reporterAuth(h, { org_email: '', org_name: 'Yahoo.com' }, env)).toEqual({ result: 'pass', domain: 'yahoo.com' });
    expect(reporterAuth(h, { org_email: '', org_name: 'Some Org Inc' }, env)).toEqual({ result: 'fail', domain: null });
  });

  it('fails closed without AUTHSERV_ID / AUTHSERV_HEADER: always "none"', () => {
    const h = { ar: 'mx.cloudflare.net; dkim=pass header.d=yahoo.com', arc: null };
    expect(reporterAuth(h, { org_email: 'a@yahoo.com', org_name: 'Yahoo' }, {})).toEqual({ result: 'none', domain: 'yahoo.com' });
    expect(reporterAuth(h, { org_email: 'a@yahoo.com', org_name: 'Yahoo' }, { AUTHSERV_ID: 'mx.cloudflare.net' })).toEqual({ result: 'none', domain: 'yahoo.com' });
  });
});

describe('hosted domains per workspace', () => {
  const resolver = dnsFrom({});
  it('refuses beyond the cap with a 429 and counts each workspace on its own', async () => {
    const w = await twoWorkspaces();
    stubCloudflare(new FakeCloudflare({ 'inboxangel.io': { id: 'zone-h' } }));
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
    expect(m.setReject.mock.calls[0][0]).toMatch(/Invalid DMARC report/);
    expect(s.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('an ordinary zipped report still files', async () => {
    const s = selfHost();
    const m = fakeMessage('rua@reports.acme.com', zipReportMime(dmarcXml('acme.com', 'ok-1')));
    await worker.email(m, s.env, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(s.rows('SELECT report_id FROM aggregate_reports')).toEqual([{ report_id: 'ok-1' }]);
  });
});

describe('a token’s daily total survives reporters coming and going', () => {
  const dkim = (d: string) => ({ headers: { 'authentication-results': `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1` } });

  it('evicting a reporter from its slot frees the slot only: its use still counts, so many cheap domains cannot each bring a fresh allowance', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTERS_PER_DAY: '2', INTAKE_MAX_TOTAL_REPORTS_PER_DAY: '5', INTAKE_MAX_REPORTS_PER_DAY: '10' });
    const sendFrom = (d: string, id: string) => send(w, dmarcXml('a-corp.com', id, d), dkim(d));
    const accepted: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m = await sendFrom(`cheap${i % 4}.example`, `r${i}`);
      if (!m.setReject.mock.calls.length) accepted.push(`r${i}`);
    }
    expect(accepted).toHaveLength(5); // the total, not 12 messages × fresh allowances
    expect(w.rows("SELECT reports FROM intake_usage WHERE reporter = '*'")).toEqual([{ reports: 5 }]);
    expect(w.rows('SELECT COUNT(*) n FROM aggregate_reports')).toEqual([{ n: 5 }]);
  });

  it('the total is by bytes too, and a rejected message gives back what it counted for its reporter', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_TOTAL_BYTES_PER_DAY: '1000' });
    expect((await send(w, dmarcXml('a-corp.com', 'b1', 'one.example'), { ...dkim('one.example'), rawSize: 800 })).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'b2', 'two.example'), { ...dkim('two.example'), rawSize: 800 })).setReject).toHaveBeenCalledOnce();
    expect(w.rows("SELECT reporter, reports, bytes FROM intake_usage WHERE reporter = 'two.example'")).toEqual([{ reporter: 'two.example', reports: 0, bytes: 0 }]);
    expect(w.rows("SELECT bytes FROM intake_usage WHERE reporter = '*'")).toEqual([{ bytes: 800 }]);
  });

  it('well-known reporters are outside the total: junk reporters exhausting it cannot block google.com', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_TOTAL_REPORTS_PER_DAY: '2' });
    for (let i = 0; i < 4; i++) await send(w, dmarcXml('a-corp.com', 'j' + i, `cheap${i}.example`), dkim(`cheap${i}.example`));
    expect((await send(w, dmarcXml('a-corp.com', 'g1', 'google.com'), dkim('google.com'))).setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reports FROM intake_usage WHERE reporter = '*'")).toEqual([{ reports: 2 }]);
  });

  it('defaults', () => {
    expect(intakeLimits({})).toMatchObject({ totalReportsPerDay: 1000, totalBytesPerDay: 1024 * 1024 * 1024 });
  });
});
