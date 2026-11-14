// G7: one structured JSON line per inbound message (no contents, no tokens, no addresses), specific refusals for mail that is not a
// DMARC report, and the authserv-id discovery log.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.setConfig({ testTimeout: 30_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { generateToken } from '../../src/hosted/tokens';
import { logAuthservDiscovery, resetAuthservDiscovery, seenAuthserv, observed, OBSERVED_MAX } from '../../src/hosted/intake-log';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment, tlsRptJson, tlsRptMime } from '../helpers/mail';
import { nxdomain, twoWorkspaces } from './world';
import { strToU8, gzipSync } from 'fflate';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  resetSchemaReadyCache(); resetAuthservDiscovery(); nxdomain();
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(String(a[0])); });
  vi.spyOn(console, 'warn').mockImplementation((...a) => { logs.push(String(a[0])); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const lines = (evt = 'intake') => logs.filter((l) => l.startsWith(`{"evt":"${evt}"`)).map((l) => JSON.parse(l));
type World = Awaited<ReturnType<typeof twoWorkspaces>>;
async function deliver(w: World, to: string, mime: string, o: { rawSize?: number; headers?: Record<string, string>; from?: string; env?: Record<string, string> } = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(to, mime, { headers: o.headers ?? GOOGLE.headers, ...(o.rawSize ? { rawSize: o.rawSize } : {}), ...(o.from ? { from: o.from } : {}) });
  await worker.email(m, { ...w.env, ...(o.env ?? {}) } as any, ctx);
  return m;
}

describe('one structured line per message', () => {
  it('accepted: outcome, reason, tier, reporter id, carrier orgs, size, records, duration, internal ids; nothing else', async () => {
    const w = await twoWorkspaces();
    const m = await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'log1')));
    const [line] = lines();
    expect(line).toEqual({ evt: 'intake', v: 1, kind: 'rua', outcome: 'accepted', reason: 'ok', tier: 'counted', reporter: 'google', dkim_org: 'google.com', from_org: 'google.com', email_matched: true, dedup: 'new', size: m.rawSize, records: 1, ms: expect.any(Number), ws: 'ws_a', dom: 1 });
    expect(line.ms).toBeGreaterThanOrEqual(0);
  });

  it('never contains the token, an address, the customer\'s domain, the sender, or report content', async () => {
    const w = await twoWorkspaces();
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'secret-report-id')), { from: 'someone@sender.example' });
    await deliver(w, `rua+${generateToken()}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')), { from: 'someone@sender.example' });
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('b-corp.org', 'x')), { from: 'someone@sender.example' });
    const all = logs.join('\n');
    for (const secret of [w.tokenA, w.tokenB, 'a-corp.com', 'b-corp.org', 'secret-report-id', 'sender.example', 'someone@', RUA, 'noreply', '199.230.200.36']) expect(all, secret).not.toContain(secret);
    expect(all).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/); // no address of any kind
    expect(lines().length).toBe(3);
  });

  it('a duplicate is logged as such', async () => {
    const w = await twoWorkspaces();
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'd')));
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'd')));
    expect(lines().map((l) => `${l.outcome}:${l.reason}`)).toEqual(['accepted:ok', 'duplicate:duplicate']);
  });

  it('unauthenticated mail says so; with AUTHSERV unset nothing is authenticated', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: '', AUTHSERV_HEADER: '' });
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'u')));
    expect(lines()[0]).toMatchObject({ outcome: 'accepted', tier: 'unauthenticated', dkim_org: null, email_matched: null });
  });

  it('TLS-RPT and the anonymous check are logged with their kind', async () => {
    const w = await twoWorkspaces();
    await deliver(w, `tls-rpt+${w.tokenA}@${RUA}`, tlsRptMime(tlsRptJson('a-corp.com')));
    expect(lines()[0]).toMatchObject({ kind: 'tls-rpt', outcome: 'accepted', ws: 'ws_a', dom: 1 });
    await deliver(w, 'check+nope@canary.readysetmail.com', 'Subject: x\r\n\r\nx');
    expect(lines()[1]).toMatchObject({ kind: 'canary', outcome: 'refused' });
  });
});

describe('mail that is not a DMARC report is refused cleanly, with a specific reason', () => {
  const cases: Array<[string, (w: World) => { to: string; mime?: string; rawSize?: number }, string, string | RegExp]> = [
    ['a mistyped local part', () => ({ to: `postmaster+x@${RUA}` }), 'bad_recipient', 'Unknown recipient'],
    ['an address that cannot be parsed', () => ({ to: 'nonsense' }), 'bad_recipient', 'Unknown recipient'],
    ['another host', () => ({ to: 'rua+x@reports.acme.com' }), 'wrong_host', 'Unknown recipient'],
    ['no token (the fixed address): a domain whose reports nobody connected', () => ({ to: `rua@${RUA}` }), 'domain_not_connected', 'Report is for a domain whose reports are not connected to this address'],
    ['a malformed token', () => ({ to: `rua+short@${RUA}` }), 'unknown_token', 'Unknown intake token'],
    ['an unknown token', () => ({ to: `rua+${generateToken()}@${RUA}` }), 'unknown_token', 'Unknown intake token'],
    ['a message over the raw cap (2 MiB by default)', (w) => ({ to: `rua+${w.tokenA}@${RUA}`, rawSize: 3 * 1024 * 1024 }), 'raw_too_large', 'Report is larger than 2 MiB'],
    ['no attachment', (w) => ({ to: `rua+${w.tokenA}@${RUA}`, mime: 'From: a@b.example\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhello\r\n--B--\r\n' }), 'no_attachment', /Could not extract attachment/],
    ['an attachment that is not a report', (w) => ({ to: `rua+${w.tokenA}@${RUA}`, mime: mimeWithAttachment(strToU8('hello world'), 'x.bin', 'application/octet-stream') }), 'wrong_attachment_type', /expected zip, gzip or XML|not a valid zip/i],
    ['an XML file that is not a report', (w) => ({ to: `rua+${w.tokenA}@${RUA}`, mime: mimeWithAttachment(strToU8('<?xml version="1.0"?><feedback><oops/></feedback>'), 'r.xml', 'text/xml') }), 'xml_invalid', /Invalid DMARC report/],
    ['a TLS-RPT report sent to the rua address', (w) => ({ to: `rua+${w.tokenA}@${RUA}`, mime: tlsRptMime(tlsRptJson('a-corp.com'), true) }), 'kind_mismatch_tlsrpt_to_rua', 'This is a TLS-RPT report; send it to the tls-rpt address, not the rua address'],
    ['a DMARC report sent to the tls-rpt address', (w) => ({ to: `tls-rpt+${w.tokenA}@${RUA}`, mime: gzipReportMime(dmarcXml('a-corp.com')) }), 'kind_mismatch_rua_to_tlsrpt', 'This is a DMARC aggregate report; send it to the rua address, not the tls-rpt address'],
    ['TLS-RPT that is not JSON', (w) => ({ to: `tls-rpt+${w.tokenA}@${RUA}`, mime: 'Subject: x\r\n\r\nnot json' }), 'json_invalid', 'Invalid TLS-RPT report JSON'],
    ['TLS-RPT for a domain the token does not own', (w) => ({ to: `tls-rpt+${w.tokenA}@${RUA}`, mime: tlsRptMime(tlsRptJson('b-corp.org')) }), 'domain_not_owned', 'Report is for a domain this address does not belong to'],
  ];
  it.each(cases)('%s', async (_n, build, reason, text) => {
    const w = await twoWorkspaces();
    const { to, mime, rawSize } = build(w);
    const m = await deliver(w, to, mime ?? gzipReportMime(dmarcXml('a-corp.com')), { rawSize });
    expect(m.setReject).toHaveBeenCalledOnce();
    typeof text === 'string' ? expect(m.setReject.mock.calls[0][0]).toBe(text) : expect(m.setReject.mock.calls[0][0]).toMatch(text);
    expect(lines()[0]).toMatchObject({ outcome: 'refused', reason });
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(0);
    expect(w.rows('SELECT COUNT(*) AS n FROM tls_reports')[0].n).toBe(0);
  });

  it('a gzip\'d TLS-RPT report to the tls-rpt address is accepted', async () => {
    const w = await twoWorkspaces();
    const m = await deliver(w, `tls-rpt+${w.tokenA}@${RUA}`, mimeWithAttachment(gzipSync(strToU8(tlsRptJson('a-corp.com'))), 'r.json.gz', 'application/tlsrpt+gzip'));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT COUNT(*) AS n FROM tls_reports')[0].n).toBe(1);
  });
});

describe('deferred (the delivery fails so the sender retries) is for deployment problems and D1 failures only', () => {
  it('not configured', async () => {
    const w = await twoWorkspaces({ INTAKE_DOMAIN: '' });
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    await expect(worker.email(m, w.env as any, ctx)).rejects.toThrow(/not configured/);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ outcome: 'deferred', reason: 'not_configured' });
  });
  it('schema not migrated', async () => {
    const { createTestD1 } = await import('@ready-set-mail/db/testing');
    const m = fakeMessage(`rua+${generateToken()}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    await expect(worker.email(m, { DB: createTestD1(), MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, CANARY_DOMAIN: 'canary.readysetmail.com' } as any, ctx)).rejects.toThrow(/out of date/);
    expect(lines()[0]).toMatchObject({ outcome: 'deferred', reason: 'schema_not_ready' });
  });
});

describe('authserv-id discovery (so AUTHSERV_ID can be set from one real message, without storing it)', () => {
  it('with AUTHSERV_* unset, the first routed message logs the topmost Authentication-Results authserv-id and the ARC one', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: '', AUTHSERV_HEADER: '' });
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')), { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com', 'arc-authentication-results': 'i=1; mx.cloudflare.net; dkim=pass' } });
    const [d] = lines('intake_authserv');
    expect(d).toEqual({ evt: 'intake_authserv', v: 2, configured: false, observed_ar: 'mx.cloudflare.net', observed_arc: 'mx.cloudflare.net', observed_arc_i: 1, note: 'observed on an inbound message; confirm against a message you sent yourself before setting AUTHSERV_ID' });
    expect(JSON.stringify(d)).not.toMatch(/Set AUTHSERV_ID|hint/); // an observation, never an instruction
  });

  it('is silent when the configured header is the receiver\'s (nothing to discover)', async () => {
    const w = await twoWorkspaces();
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    expect(lines('intake_authserv')).toEqual([]);
  });

  it('is logged again when configured but the message names another server (a wrong AUTHSERV_ID shows what to set)', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: 'wrong.example' });
    await deliver(w, `rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    expect(lines('intake_authserv')[0]).toMatchObject({ configured: true, observed_ar: 'mx.cloudflare.net' });
  });

  it('only for messages that reached a valid token (random spam to a bad token cannot fill the log)', async () => {
    const w = await twoWorkspaces({ AUTHSERV_ID: '', AUTHSERV_HEADER: '' });
    for (let i = 0; i < 10; i++) await deliver(w, `rua+${generateToken()}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    expect(lines('intake_authserv')).toEqual([]);
  });

  it('is rate limited to 5 lines an hour per isolate', () => {
    const env = {};
    const h = { ar: 'mx.cloudflare.net; dkim=pass', arc: null };
    for (let i = 0; i < 20; i++) logAuthservDiscovery(h, env, false, 1_000_000 + i);
    expect(lines('intake_authserv')).toHaveLength(5);
    logAuthservDiscovery(h, env, false, 1_000_000 + 3_600_001);
    expect(lines('intake_authserv')).toHaveLength(6);
  });

  it('never logs an address; what it does log is printable ASCII, capped, and phrased as an observation', () => {
    expect(seenAuthserv({ ar: 'someone@evil.example; dkim=pass', arc: 'i=1; a b c; x' })).toEqual({ ar: null, arc: { i: 1, id: null } });
    expect(seenAuthserv({ ar: 'MX.Cloudflare.NET 1 (c); dkim=pass', arc: null })).toEqual({ ar: 'MX.Cloudflare.NET', arc: null });
    logAuthservDiscovery({ ar: 'mx.cloudflare.net; dkim=pass header.d=a.com smtp.mailfrom=alice@a.com', arc: null }, {}, false);
    expect(logs.join('\n')).not.toContain('alice');
    expect(logs.join('\n')).not.toContain('a.com');
  });

  it('a hostile value is neutralised: control characters and non-ASCII give null, long values are cut at 64, and a "Set AUTHSERV_ID=" lookalike cannot form an instruction', () => {
    expect(observed('mx\u0000.example')).toBeNull();
    expect(observed('mx\u001b[31m.example')).toBeNull();
    expect(observed('m\u00e9.example')).toBeNull();
    expect(observed('a'.repeat(500))).toHaveLength(OBSERVED_MAX);
    expect(observed('Set AUTHSERV_ID=evil.example AUTHSERV_HEADER=ar')).toBeNull(); // spaces: not an id
    expect(observed('Set')).toBe('Set');
    logAuthservDiscovery({ ar: 'Set\nAUTHSERV_ID=evil.example; dkim=pass', arc: null }, {}, false);
    const line = lines('intake_authserv').at(-1);
    expect(line.observed_ar).toBeNull();
    expect(JSON.stringify(line)).not.toContain('evil.example');
  });

  it('with ARC only (no plain header) it observes the ARC authserv-id, without telling the operator what to set', () => {
    logAuthservDiscovery({ ar: null, arc: 'i=1; arc.example; dkim=pass' }, {}, false);
    expect(lines('intake_authserv')[0]).toMatchObject({ observed_ar: null, observed_arc: 'arc.example', observed_arc_i: 1 });
    expect(JSON.stringify(lines('intake_authserv')[0])).not.toMatch(/Set AUTHSERV_ID/);
  });
});
