// Hostile inputs through the real email() entry point in hosted mode: archive bombs, entity tricks, oversized fields, bad UTF-8,
// a domain the token does not own, absurd dates, duplicates. Each is refused with a specific reason (and nothing is stored) or
// handled safely, and the sender is told which in the SMTP session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync, zipSync, strToU8 } from 'fflate';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { fakeMessage, gzipReportMime, mimeWithAttachment, zipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

interface X { org?: string; email?: string; id?: string; domain?: string; begin?: number; end?: number; headerFrom?: string; ip?: string; count?: string; dateRange?: boolean; before?: string; dkimDomain?: string }
const xml = (o: X = {}) => `<?xml version="1.0"?>${o.before ?? ''}<feedback>
<report_metadata><org_name>${o.org ?? 'google.com'}</org_name><email>${o.email ?? 'noreply-dmarc-support@google.com'}</email><report_id>${o.id ?? 'h1'}</report_id>
${o.dateRange === false ? '' : `<date_range><begin>${o.begin ?? NOW - 86400}</begin><end>${o.end ?? NOW - 1}</end></date_range>`}</report_metadata>
<policy_published><domain>${o.domain ?? 'a-corp.com'}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>
<record><row><source_ip>${o.ip ?? '198.51.100.7'}</source_ip><count>${o.count ?? '3'}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
<identifiers><header_from>${o.headerFrom ?? 'a-corp.com'}</header_from></identifiers>
<auth_results><dkim><domain>${o.dkimDomain ?? 'a-corp.com'}</domain><result>pass</result></dkim></auth_results></record>
</feedback>`;

type World = Awaited<ReturnType<typeof twoWorkspaces>>;
async function deliver(w: World, mime: string, o: { env?: Record<string, string>; to?: string } = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(o.to ?? `rua+${w.tokenA}@${RUA}`, mime, GOOGLE);
  await worker.email(m, { ...w.env, ...(o.env ?? {}) } as any, ctx);
  return m;
}
const reports = (w: World) => w.rows('SELECT report_id FROM aggregate_reports ORDER BY id').map((r) => r.report_id);
const lastLog = () => (console.warn as any).mock.calls.map((c: any[]) => String(c[0])).filter((l: string) => l.startsWith('{"evt":"intake"')).map((l: string) => JSON.parse(l)).at(-1);

async function refused(mime: string, reason: string, text: RegExp | string, env?: Record<string, string>) {
  const w = await twoWorkspaces(env);
  const m = await deliver(w, mime);
  expect(m.setReject).toHaveBeenCalledOnce();
  const said = m.setReject.mock.calls[0][0];
  typeof text === 'string' ? expect(said).toBe(text) : expect(said).toMatch(text);
  expect(lastLog()).toMatchObject({ outcome: 'refused', reason });
  expect(reports(w)).toEqual([]);
  expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(0);
  return { w, m };
}

describe('archive bombs', () => {
  it('a gzip bomb stops at the decompressed cap, without inflating all of it', async () => {
    const bomb = strToU8('<?xml version="1.0"?><feedback>' + ' '.repeat(40 * 1024 * 1024) + '</feedback>');
    await refused(mimeWithAttachment(gzipSync(bomb), 'r.xml.gz', 'application/gzip'), 'decompressed_too_large', 'Report is too large once decompressed');
  });

  it('the decompressed cap is the operator\'s: INTAKE_MAX_DECOMPRESSED_BYTES (default 1 MiB hosted)', async () => {
    const big = strToU8(xml().replace('</feedback>', '<!--' + 'x'.repeat(512 * 1024) + '--></feedback>'));
    const mime = mimeWithAttachment(gzipSync(big), 'r.xml.gz', 'application/gzip');
    await refused(mime, 'decompressed_too_large', 'Report is too large once decompressed', { INTAKE_MAX_DECOMPRESSED_BYTES: '400000' });
    const w = await twoWorkspaces();
    expect((await deliver(w, mime)).setReject).not.toHaveBeenCalled(); // under the 1 MiB default
  });

  it('a gzip whose header carries megabytes of comment is refused before inflating (it would cost time quadratic in the comment)', async () => {
    const g = gzipSync(strToU8(xml()));
    const comment = new Uint8Array(6 * 1024 * 1024).fill(0x61); comment[comment.length - 1] = 0;
    const bomb = new Uint8Array(g.length + comment.length);
    bomb.set(g.subarray(0, 10)); bomb.set(comment, 10); bomb.set(g.subarray(10), 10 + comment.length); bomb[3] |= 0x10;
    const t = Date.now();
    await refused(mimeWithAttachment(bomb, 'r.xml.gz', 'application/gzip'), 'archive_invalid', /gzip header is longer than 1024 bytes/, { INTAKE_MAX_RAW_BYTES: String(25 * 1024 * 1024) });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('a gzip inside a gzip is not inflated twice: the inner stream is just not a report', async () => {
    const inner = gzipSync(strToU8('<?xml version="1.0"?><feedback>' + ' '.repeat(5 * 1024 * 1024) + '</feedback>'));
    await refused(mimeWithAttachment(gzipSync(inner), 'r.xml.gz.gz', 'application/gzip'), 'archive_invalid', /Invalid DMARC report|could not be unpacked|Could not extract/i);
  });

  it('a zip with many entries is refused before anything is inflated', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 50; i++) files[`f${i}.xml`] = strToU8(xml({ id: 'z' + i }));
    await refused(mimeWithAttachment(zipSync(files), 'r.zip', 'application/zip'), 'archive_invalid', /entries/);
  });

  it('a zip whose single entry inflates past the cap is refused', async () => {
    const bomb = strToU8('<?xml version="1.0"?><feedback>' + ' '.repeat(12 * 1024 * 1024) + '</feedback>');
    await refused(mimeWithAttachment(zipSync({ 'r.xml': bomb }), 'r.zip', 'application/zip'), 'decompressed_too_large', 'Report is too large once decompressed');
  });

  it('a corrupt gzip and an attachment that is not an archive or XML are refused with their own reasons', async () => {
    await refused(mimeWithAttachment(new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]), 'r.xml.gz', 'application/gzip'), 'archive_invalid', /Invalid DMARC report/);
    await refused(mimeWithAttachment(strToU8('this is not a report'), 'r.bin', 'application/octet-stream'), 'wrong_attachment_type', /expected zip, gzip or XML|not a valid zip/i);
    await refused('From: a@b.example\r\nTo: x\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nno attachment\r\n--B--\r\n', 'no_attachment', /Could not extract attachment/);
  });
});

describe('XML entity tricks', () => {
  it('a DOCTYPE with entity declarations (billion laughs, external entity) is refused before the parser runs', async () => {
    const laughs = '<!DOCTYPE feedback [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>';
    await refused(gzipReportMime(xml({ before: laughs, org: '&c;' })), 'xml_invalid', /DOCTYPE and entity declarations are not allowed/);
    await refused(gzipReportMime(xml({ before: '<!DOCTYPE feedback [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>', org: '&xxe;' })), 'xml_invalid', /not allowed/);
  });

  it('the five standard escapes still work in stored fields', async () => {
    const w = await twoWorkspaces();
    const m = await deliver(w, gzipReportMime(xml({ org: 'A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;', id: 'esc' })));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT org_name FROM aggregate_reports')).toEqual([{ org_name: 'A & B <c> "d" \'e\'' }]);
  });
});

describe('oversized fields', () => {
  it.each([
    ['org_name', xml({ org: 'o'.repeat(300) })],
    ['report_id', xml({ id: 'r'.repeat(300) })],
    ['policy domain', xml({ domain: 'd'.repeat(300) + '.com' })],
    ['header_from', xml({ headerFrom: 'h'.repeat(300) + '.com' })],
    ['dkim domain', xml({ dkimDomain: 'k'.repeat(300) + '.com' })],
    ['source_ip', xml({ ip: 'f'.repeat(60) })],
    ['reporter email', xml({ email: 'e'.repeat(600) + '@google.com' })],
  ])('%s is refused with a specific reason', async (_n, body) => {
    await refused(gzipReportMime(body), 'field_too_long', /longer than \d+ characters/);
  });

  it('a count claiming more messages than a 32-bit number is clamped, not stored raw', async () => {
    const w = await twoWorkspaces();
    await deliver(w, gzipReportMime(xml({ count: '99999999999999999999' })));
    expect(w.rows('SELECT total_count FROM aggregate_reports')).toEqual([{ total_count: 2_147_483_647 }]);
  });
});

describe('invalid UTF-8', () => {
  it('bytes that are not UTF-8 are refused, not silently mangled into replacement characters', async () => {
    const bytes = new Uint8Array([...strToU8('<?xml version="1.0"?><feedback><report_metadata><org_name>'), 0xff, 0xfe, 0xc3, 0x28, ...strToU8('</org_name></report_metadata></feedback>')]);
    await refused(mimeWithAttachment(gzipSync(bytes), 'r.xml.gz', 'application/gzip'), 'archive_invalid', /Invalid DMARC report|UTF-8/i);
  });
});

describe('a domain the token does not own', () => {
  it('is refused with the legacy message and stored nowhere', async () => {
    await refused(gzipReportMime(xml({ domain: 'b-corp.org' })), 'domain_not_owned', 'Report is for a domain this address does not belong to');
    // the sender's own text is never reflected: not the domain, and the answer is the same for a domain another workspace owns or nobody does
    await refused(gzipReportMime(xml({ domain: 'nobody-registered-this.example' })), 'domain_not_owned', 'Report is for a domain this address does not belong to');
  });
});

describe('absurd dates are refused with a reason', () => {
  const D = 86400;
  it.each([
    ['ends more than a day in the future', xml({ begin: NOW, end: NOW + 3 * D })],
    ['begins after it ends', xml({ begin: NOW - D, end: NOW - 2 * D })],
    ['spans more than 31 days', xml({ begin: NOW - 40 * D, end: NOW - D })],
    ['begins before 2012', xml({ begin: 1_300_000_000, end: 1_300_000_000 + D })],
    ['an absurd far-future period', xml({ begin: 99_999_999_999, end: 99_999_999_999 + D })],
    ['no date range at all', xml({ dateRange: false })],
    ['a date that is not a number', xml().replace(/<begin>\d+<\/begin>/, '<begin>soon</begin>')],
  ])('%s', async (_n, body) => {
    await refused(gzipReportMime(body), 'date_range_invalid', /./);
  });

  it('a normal day, a week and exactly a month are accepted; a report ending an hour ahead (clock skew) is too', async () => {
    const w = await twoWorkspaces();
    for (const [i, [b, e]] of ([[NOW - 2 * D, NOW - D], [NOW - 8 * D, NOW - D], [NOW - 32 * D, NOW - D], [NOW - 3600, NOW + 3600]] as const).entries()) {
      expect((await deliver(w, gzipReportMime(xml({ id: 'ok' + i, begin: b, end: e })))).setReject, `range ${i}`).not.toHaveBeenCalled();
    }
    expect(reports(w)).toHaveLength(4);
  });
});

describe('duplicate report ids', () => {
  it('are idempotent: one report, its records once, accepted every time', async () => {
    const w = await twoWorkspaces();
    for (let i = 0; i < 3; i++) expect((await deliver(w, gzipReportMime(xml({ id: 'same' })))).setReject).not.toHaveBeenCalled();
    expect(reports(w)).toEqual(['google|same']);
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBe(1);
    expect(w.rows('SELECT records FROM workspace_storage WHERE workspace_id = ?', 'ws_a')).toEqual([{ records: 1 }]);
    expect(lastLog()).toBeUndefined(); // accepted lines are info level (console.log), checked in intake-log.test.ts
  });

  it('the same report id under another token (another domain) is a different report', async () => {
    const w = await twoWorkspaces();
    await deliver(w, gzipReportMime(xml({ id: 'same' })));
    const m = fakeMessage(`rua+${w.tokenB}@${RUA}`, gzipReportMime(xml({ id: 'same', domain: 'b-corp.org', headerFrom: 'b-corp.org' })), GOOGLE);
    await worker.email(m, w.env as any, ctx);
    expect(w.rows('SELECT domain_id, report_id FROM aggregate_reports ORDER BY domain_id')).toEqual([{ domain_id: 1, report_id: 'google|same' }, { domain_id: 2, report_id: 'google|same' }]);
  });
});

describe('zip bomb with a lying central directory', () => {
  it('cannot make the Worker inflate more than the cap (the cap is on what is actually produced)', async () => {
    const real = zipSync({ 'r.xml': strToU8('<?xml version="1.0"?><feedback>' + ' '.repeat(12 * 1024 * 1024) + '</feedback>') });
    // overwrite the declared uncompressed size (central directory and local header) with 100
    const lie = new Uint8Array(real);
    const view = new DataView(lie.buffer);
    for (let i = 0; i < lie.length - 4; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x02014b50) view.setUint32(i + 24, 100, true); // central directory: uncompressed size
      if (sig === 0x04034b50) view.setUint32(i + 22, 100, true); // local header: uncompressed size
    }
    const w = await twoWorkspaces();
    const m = await deliver(w, mimeWithAttachment(lie, 'r.zip', 'application/zip'));
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(reports(w)).toEqual([]);
  });
});
