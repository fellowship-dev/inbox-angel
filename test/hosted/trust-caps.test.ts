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

const GOOGLE = { headers: { 'authentication-results': 'mx.example; dkim=pass header.d=google.com header.s=s1' } };
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

describe('unauthenticated junk cannot exhaust genuine reports', () => {
  const MS = { headers: { 'authentication-results': 'mx.example; spf=pass smtp.mailfrom=dmarcreport@microsoft.com' } };
  const GRPT = (w: Awaited<ReturnType<typeof twoWorkspaces>>, id: string, o: Parameters<typeof fakeMessage>[2] = GOOGLE) => send(w, dmarcXml('a-corp.com', id), o);

  it('junk fills the shared unauthenticated bucket (reports), then a google.com report is still stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_REPORTS_PER_DAY: '3' });
    for (let i = 0; i < 3; i++) expect((await send(w, dmarcXml('a-corp.com', 'junk' + i))).setReject).not.toHaveBeenCalled();
    const over = await send(w, dmarcXml('a-corp.com', 'junk-over'));
    expect(over.setReject).toHaveBeenCalledOnce();
    expect(over.setReject.mock.calls[0][0]).toMatch(/Daily intake limit/);
    // forged auth for a different domain than the report claims still only gets a bucket of its own domain, never the '' bucket
    const g = await GRPT(w, 'genuine');
    expect(g.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT report_id, reporter_auth, reporter_auth_domain FROM aggregate_reports WHERE report_id = 'genuine'")).toEqual([{ report_id: 'genuine', reporter_auth: 'pass', reporter_auth_domain: 'google.com' }]);
    expect(w.rows('SELECT reporter, reports FROM intake_usage ORDER BY reporter')).toEqual([{ reporter: '', reports: 3 }, { reporter: 'google.com', reports: 1 }]);
  });

  it('junk fills the shared bucket by bytes, then a google.com report is still stored', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_UNAUTH_BYTES_PER_DAY: '1000' });
    expect((await send(w, dmarcXml('a-corp.com', 'j1'), { rawSize: 900 })).setReject).not.toHaveBeenCalled();
    expect((await send(w, dmarcXml('a-corp.com', 'j2'), { rawSize: 200 })).setReject).toHaveBeenCalledOnce();
    expect((await GRPT(w, 'genuine', { ...GOOGLE, rawSize: 5_000_000 })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map(r => r.report_id)).toEqual(['j1', 'genuine']);
  });

  it('a reporter at its own cap does not block another authenticated reporter', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTS_PER_DAY: '2' });
    for (const id of ['g1', 'g2']) expect((await GRPT(w, id)).setReject).not.toHaveBeenCalled();
    expect((await GRPT(w, 'g3')).setReject).toHaveBeenCalledOnce();
    expect((await GRPT(w, 'm1', MS)).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter, reports FROM intake_usage ORDER BY reporter')).toEqual([{ reporter: 'google.com', reports: 2 }, { reporter: 'microsoft.com', reports: 1 }]);
  });

  it('bounds the distinct authenticated reporters per token per day', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_REPORTERS_PER_DAY: '1' });
    expect((await GRPT(w, 'g1')).setReject).not.toHaveBeenCalled();
    expect((await GRPT(w, 'm1', MS)).setReject).toHaveBeenCalledOnce();
    expect((await GRPT(w, 'g2')).setReject).not.toHaveBeenCalled(); // an already-known reporter keeps going
  });

  it('defaults', () => {
    expect(intakeLimits({})).toMatchObject({ reportsPerDay: 50, bytesPerDay: 50 * 1024 * 1024, reportersPerDay: 20, unauthReportsPerDay: 10, unauthBytesPerDay: 10 * 1024 * 1024 });
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

  it('pass on an aligned DKIM, SPF or DMARC pass; fail when nothing aligned passes; none without the header', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'k'), AR('mx.example; dkim=pass header.d=mail.google.com header.s=s1'));
    await send(w, dmarcXml('a-corp.com', 's'), AR('mx.example; dkim=fail header.d=google.com; spf=pass smtp.mailfrom=bounce@google.com'));
    await send(w, dmarcXml('a-corp.com', 'f1'), AR('mx.example; dkim=pass header.d=evil.com; spf=pass smtp.mailfrom=x@evil.com; dmarc=fail header.from=google.com'));
    await send(w, dmarcXml('a-corp.com', 'f2'), AR('mx.example; dkim=fail header.d=google.com; spf=softfail smtp.mailfrom=x@google.com'));
    await send(w, dmarcXml('a-corp.com', 'd'), AR('mx.example; dmarc=pass header.from=google.com'));
    await send(w, dmarcXml('a-corp.com', 'n'));
    expect(stored(w)).toEqual([
      { reporter_auth: 'pass', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'pass', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'fail', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'fail', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'pass', reporter_auth_domain: 'google.com' },
      { reporter_auth: 'none', reporter_auth_domain: 'google.com' },
    ]);
  });

  it('is exposed by the reports queries (so the list/detail API carries it)', async () => {
    const w = await twoWorkspaces();
    await send(w, dmarcXml('a-corp.com', 'q'), AR('mx.example; spf=pass smtp.mailfrom=a@google.com'));
    const { forWorkspace } = await import('@inbox-angel/db');
    expect((await forWorkspace(w.env.DB, 'ws_a').reports.recent())[0]).toMatchObject({ reporter_auth: 'pass', reporter_auth_domain: 'google.com' });
    expect(await forWorkspace(w.env.DB, 'ws_a').reports.getWithDomain(1)).toMatchObject({ reporter_auth: 'pass' });
  });

  it('uses the org name when the email is absent, and fails when the org is unknowable', () => {
    const h = new Headers({ 'authentication-results': 'x; dkim=pass header.d=yahoo.com' });
    expect(reporterAuth(h, { org_email: '', org_name: 'Yahoo.com' })).toEqual({ result: 'pass', domain: 'yahoo.com' });
    expect(reporterAuth(h, { org_email: '', org_name: 'Some Org Inc' })).toEqual({ result: 'fail', domain: null });
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
