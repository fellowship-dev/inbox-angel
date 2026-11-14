// Hostile input classes taken from parsedmarc's 2026 security advisories (CHANGELOG 11.2.2 and 11.3.0, read for the IDEAS only: no code from
// that project is used, and the inputs below are generated here). Each class must be refused (or handled) quickly, with a reason, and store
// nothing. The advisory IDs are the names of the classes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { fakeMessage, gzipReportMime, mimeWithAttachment } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

interface X { id?: string; begin?: number | string; end?: number | string; ip?: string; count?: string; inner?: string; records?: string }
const xml = (o: X = {}) => `<?xml version="1.0"?><feedback>
<report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>${o.id ?? 'p1'}</report_id>
<date_range><begin>${o.begin ?? NOW - 86400}</begin><end>${o.end ?? NOW - 1}</end></date_range></report_metadata>
<policy_published><domain>a-corp.com</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>
${o.records ?? `<record><row><source_ip>${o.ip ?? '198.51.100.7'}</source_ip><count>${o.count ?? '3'}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
<identifiers><header_from>a-corp.com</header_from>${o.inner ?? ''}</identifiers>
<auth_results><dkim><domain>a-corp.com</domain><result>pass</result></dkim></auth_results></record>`}
</feedback>`;

type World = Awaited<ReturnType<typeof twoWorkspaces>>;
const lastLog = () => [...(console.log as any).mock.calls, ...(console.warn as any).mock.calls].map((c: any[]) => String(c[0])).filter((l: string) => l.startsWith('{"evt":"intake"')).map((l: string) => JSON.parse(l)).at(-1);
async function deliver(w: World, mime: string, env: Record<string, string> = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, mime, GOOGLE);
  const t = Date.now();
  await worker.email(m, { ...w.env, ...env } as any, ctx);
  return { m, ms: Date.now() - t };
}
const stored = (w: World) => w.rows('SELECT report_id FROM aggregate_reports').length;
async function refused(mime: string, reason: string, maxMs = 8000, env?: Record<string, string>) {
  const w = await twoWorkspaces(env);
  const { m, ms } = await deliver(w, mime, env);
  expect(m.setReject).toHaveBeenCalledOnce();
  expect(lastLog()).toMatchObject({ outcome: 'refused', reason });
  expect(stored(w)).toBe(0);
  expect(ms).toBeLessThan(maxMs);
}
const gz = (s: string) => mimeWithAttachment(gzipSync(strToU8(s)), 'r.xml.gz', 'application/gzip');

describe('GHSA-q7gm-8cj9-94hr: deeply nested or very wide XML', () => {
  it('30 MiB of unclosed tags (a 30 KB attachment) stops at the decompression cap', async () => {
    await refused(gz('<?xml version="1.0"?>' + '<a>'.repeat(10 * 1024 * 1024)), 'decompressed_too_large');
  });
  it('unclosed tags that fit under the cap are refused for their depth, not parsed', async () => {
    await refused(gz('<?xml version="1.0"?><feedback>' + '<a>'.repeat(300_000)), 'xml_invalid');
  });
  it('a nest of 200 well-formed levels is refused for its depth', async () => {
    await refused(gz(xml({ inner: '<a>'.repeat(200) + '</a>'.repeat(200) })), 'xml_invalid');
  });
  it('hundreds of thousands of sibling elements are refused for their number', async () => {
    await refused(gz(xml({ inner: '<a/>'.repeat(200_000) })), 'xml_invalid');
  });
});

describe('GHSA-p85v-578x-3wcf and #947: date ranges', () => {
  it('a range of millions of days is refused, not expanded', async () => {
    await refused(gz(xml({ begin: 1, end: 2_900_000 * 86400 })), 'date_range_invalid');
  });
  it('a report dated in the year 2100 is refused', async () => {
    await refused(gz(xml({ begin: 4102444800, end: 4102444800 + 86400 })), 'date_range_invalid');
  });
  it('a begin that is not a number is refused', async () => {
    await refused(gz(xml({ begin: 'tomorrow' })), 'date_range_invalid');
  });
});

describe('GHSA-9fw6-mwqr-p43m: huge report ids', () => {
  it('a 5 MiB report_id stops at the decompression cap', async () => {
    await refused(gz(xml({ id: 'x'.repeat(5 * 1024 * 1024) })), 'decompressed_too_large');
  });
  it('a 100 KB report_id that fits under the cap is refused for its length', async () => {
    await refused(gz(xml({ id: 'x'.repeat(100 * 1024) })), 'field_too_long');
  });
});

describe('GHSA-fxr7-7h9q-v949: values a database would choke on', () => {
  it('a NUL character in a field is refused', async () => {
    await refused(gz(xml({ id: 'a\u0000b' })), 'xml_invalid');
  });
  it('a source_ip that is not an IP address is not stored as one', async () => {
    const w = await twoWorkspaces();
    const { m } = await deliver(w, gz(xml({ ip: 'not-an-ip' })));
    if (!m.setReject.mock.calls.length) expect(w.rows("SELECT source_ip FROM report_records WHERE source_ip = 'not-an-ip'")).toEqual([]);
    else expect(lastLog().outcome).toBe('refused');
  });
  it('a count past 2^31 is clamped, not stored raw', async () => {
    const w = await twoWorkspaces();
    const { m } = await deliver(w, gz(xml({ count: '99999999999999' })));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT MAX(count) c FROM report_records')[0].c).toBeLessThanOrEqual(2147483647);
  });
});

describe('GHSA-rwfh-ww9c-jm9m: one lookup per record', () => {
  it('many distinct source IPs cause no network lookups from an unauthenticated sender', async () => {
    const records = Array.from({ length: 150 }, (_, i) => `<record><row><source_ip>203.0.${Math.floor(i / 250)}.${i % 250}</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>a-corp.com</header_from></identifiers></record>`).join('');
    const w = await twoWorkspaces();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ Status: 3 })));
    vi.stubGlobal('fetch', fetchSpy);
    resetSchemaReadyCache();
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gz(xml({ records })), {}); // no Authentication-Results: unauthenticated
    await worker.email(m, w.env as any, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter_tier t FROM aggregate_reports')).toEqual([{ t: 'unauthenticated' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GHSA-qcc2-4x3v-v4g7: crafted MIME', () => {
  const report = () => gzipReportMime(xml());
  const timed = async (mime: string) => {
    const w = await twoWorkspaces();
    const { ms } = await deliver(w, mime);
    expect(ms).toBeLessThan(8000);
    return w;
  };
  it('half a megabyte of blank lines before the attachment is handled in bounded time', async () => { await timed('\r\n'.repeat(512 * 1024) + report()); });
  it('900 nested multipart levels are handled in bounded time', async () => {
    let s = ''; for (let i = 0; i < 900; i++) s += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
    await timed(s + report());
  });
  it('a flood of header lines is handled in bounded time', async () => {
    await timed(Array.from({ length: 80_000 }, (_, i) => `X-H${i}: v`).join('\r\n') + '\r\n' + report());
  });
});
