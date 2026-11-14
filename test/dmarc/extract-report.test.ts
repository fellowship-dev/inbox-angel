import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { extractReport, ParserError } from '../../src/dmarc/extract-report';

const fixture = (name: string) => readFileSync(join(__dirname, '../fixtures', name));
const fixtureStr = (name: string) => readFileSync(join(__dirname, '../fixtures', name), 'utf-8');

describe('extractReport', () => {
  it('extracts raw XML bytes', () => {
    const bytes = fixture('extract-nice.xml');
    const result = extractReport(new Uint8Array(bytes));
    expect(result).toContain('<feedback>');
  });

  it('extracts gzipped XML', () => {
    const bytes = fixture('extract-nice.xml.gz');
    const result = extractReport(new Uint8Array(bytes));
    expect(result).toContain('<feedback>');
  });

  it('extracts zipped XML', () => {
    const bytes = fixture('extract-nice.xml.zip');
    const result = extractReport(new Uint8Array(bytes));
    expect(result).toContain('<feedback>');
  });

  it('gzip output matches plain XML content', () => {
    const fromXml  = extractReport(new Uint8Array(fixture('extract-nice.xml')));
    const fromGzip = extractReport(new Uint8Array(fixture('extract-nice.xml.gz')));
    const fromZip  = extractReport(new Uint8Array(fixture('extract-nice.xml.zip')));
    expect(fromGzip.trim()).toBe(fromXml.trim());
    expect(fromZip.trim()).toBe(fromXml.trim());
  });

  it('extracts real-world fastmail gzip attachment', () => {
    const bytes = fixture('fastmail.xml.gz');
    const result = extractReport(new Uint8Array(bytes));
    expect(result).toContain('<feedback>');
  });

  it('returns plain XML string as-is', () => {
    const xml = fixtureStr('extract-nice.xml');
    const result = extractReport(xml);
    expect(result).toContain('<feedback>');
  });

  it('decodes base64-encoded zip', () => {
    const bytes = fixture('extract-nice.xml.zip');
    const b64 = Buffer.from(bytes).toString('base64');
    const result = extractReport(b64);
    expect(result).toContain('<feedback>');
  });

  it('decodes base64-encoded gzip', () => {
    const bytes = fixture('extract-nice.xml.gz');
    const b64 = Buffer.from(bytes).toString('base64');
    const result = extractReport(b64);
    expect(result).toContain('<feedback>');
  });

  it('throws ParserError on invalid bytes', () => {
    expect(() => extractReport(new Uint8Array([0x00, 0x01, 0x02, 0x03])))
      .toThrow(ParserError);
  });

  it('accepts ArrayBuffer input', () => {
    const bytes = fixture('extract-nice.xml.gz');
    // Node.js Buffer.buffer may have byteOffset > 0 (shared pool) — slice to get clean ArrayBuffer
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = extractReport(ab);
    expect(result).toContain('<feedback>');
  });
});

describe('gzip header guard (quadratic work in a huge FCOMMENT/FEXTRA)', () => {
  const withHeader = (flagBit: number, junk: Uint8Array) => {
    const g = gzipSync(strToU8('<?xml version="1.0"?><feedback/>'));
    const out = new Uint8Array(g.length + junk.length);
    out.set(g.subarray(0, 10)); out.set(junk, 10); out.set(g.subarray(10), 10 + junk.length);
    out[3] |= flagBit;
    return out;
  };
  const comment = (n: number) => { const c = new Uint8Array(n).fill(0x61); c[n - 1] = 0; return c; };

  it('a multi-megabyte comment is refused at once, not inflated', () => {
    const t = Date.now();
    expect(() => extractReport(withHeader(0x10, comment(3_000_000)), { maxBytes: 1_000_000 })).toThrow(/gzip header is longer than 1024 bytes/);
    expect(Date.now() - t).toBeLessThan(200);
  });
  it('same for FNAME, an unterminated name and a huge FEXTRA', () => {
    expect(() => extractReport(withHeader(0x08, comment(5000)), { maxBytes: 1_000_000 })).toThrow(/gzip header/);
    expect(() => extractReport(withHeader(0x08, new Uint8Array(5000).fill(0x61)), { maxBytes: 1_000_000 })).toThrow(/gzip header/);
    const extra = new Uint8Array(2 + 60_000); extra[0] = 60_000 & 255; extra[1] = 60_000 >> 8;
    expect(() => extractReport(withHeader(0x04, extra), { maxBytes: 1_000_000 })).toThrow(/gzip header/);
  });
  it('an ordinary header (a file name, a short comment) still works', () => {
    expect(extractReport(withHeader(0x08, new Uint8Array([...strToU8('report.xml'), 0])), { maxBytes: 1_000_000 })).toContain('<feedback/>');
    expect(extractReport(withHeader(0x10, comment(200)), { maxBytes: 1_000_000 })).toContain('<feedback/>');
  });
});
