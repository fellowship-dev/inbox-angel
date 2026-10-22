import { describe, it, expect, vi } from 'vitest';

// Inflation-bomb cases are CPU-heavy: the 5 s default flakes when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });
import { gzipSync as nodeGzip } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { extractReport, ReportTooLargeError, ParserError } from '../../src/dmarc/extract-report';

const MAX = 25 * 1024 * 1024;
const MiB = 1024 * 1024;

describe('capped extraction aborts while inflating', () => {
  it('a ~200 KB gzip of 200 MB of zeros stops at the cap, not after a full inflate', () => {
    const gz = nodeGzip(Buffer.alloc(200 * MiB));
    expect(gz.length).toBeLessThan(400_000);
    let caught: unknown;
    try { extractReport(new Uint8Array(gz), { maxBytes: MAX }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReportTooLargeError);
    // output produced before the abort: the cap plus at most one ~1 KB input slice's worth
    expect((caught as ReportTooLargeError).produced).toBeLessThan(MAX + 2 * MiB);
  });

  it('a zip entry of 200 MB of zeros stops at the cap too, whatever its header claims', () => {
    const zip = zipSync({ 'r.xml': new Uint8Array(200 * MiB) });
    let caught: unknown;
    try { extractReport(zip, { maxBytes: MAX }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReportTooLargeError);
    expect((caught as ReportTooLargeError).produced).toBeLessThan(MAX + 2 * MiB);
  });

  it('rejects a 500-entry zip without inflating any entry', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 500; i++) files[`f${i}.xml`] = strToU8(`<a>${i}</a>`);
    expect(() => extractReport(zipSync(files), { maxBytes: MAX })).toThrow(/500 entries/);
  });

  it('reads the first .xml/.json entry of a small zip, ignoring a stray file; refuses one with no report', () => {
    const xml = '<?xml version="1.0"?><feedback/>';
    expect(extractReport(zipSync({ 'readme.txt': strToU8('hi'), 'r.xml': strToU8(xml) }), { maxBytes: MAX })).toBe(xml);
    expect(extractReport(zipSync({ 'r.json': strToU8('{"a":1}') }), { maxBytes: MAX })).toBe('{"a":1}');
    expect(() => extractReport(zipSync({ 'a.txt': strToU8('x'), 'b.bin': strToU8('y') }), { maxBytes: MAX })).toThrow(ParserError);
    expect(() => extractReport(zipSync({ 'a.exe': strToU8('x') }), { maxBytes: MAX })).toThrow(/no \.xml or \.json/);
  });

  it('an honest report just under the cap still extracts', () => {
    const xml = '<?xml version="1.0"?><feedback>' + ' '.repeat(24 * MiB) + '</feedback>';
    expect(extractReport(new Uint8Array(nodeGzip(xml)), { maxBytes: MAX }).length).toBe(xml.length);
  });
});
