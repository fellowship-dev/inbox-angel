import { describe, it, expect } from 'vitest';
import { classifyDohBody, createResolver, decodeTxtData } from '../src/doh';
import { fakeResolver, resp } from './helpers';

describe('classifyDohBody', () => {
  it('NXDOMAIN → nxdomain', () => {
    expect(classifyDohBody({ Status: 3 }, 'TXT').status).toBe('nxdomain');
  });
  it('NOERROR without Answer → nodata', () => {
    expect(classifyDohBody({ Status: 0 }, 'TXT').status).toBe('nodata');
  });
  it('NOERROR with only a CNAME in the answer → nodata for TXT', () => {
    const r = classifyDohBody({ Status: 0, Answer: [{ name: 'a.', type: 5, data: 'b.' }] }, 'TXT');
    expect(r.status).toBe('nodata');
  });
  it('NOERROR with records → ok and drops CNAME chain entries', () => {
    const r = classifyDohBody({ Status: 0, Answer: [{ name: 'a.', type: 5, data: 'b.' }, { name: 'b.', type: 16, data: '"x"' }] }, 'TXT');
    expect(r.status).toBe('ok');
    expect(r.answers).toHaveLength(1);
  });
  it.each([2, 5, 1])('RCODE %i → error, not "no record"', rcode => {
    const r = classifyDohBody({ Status: rcode }, 'TXT');
    expect(r.status).toBe('error');
    expect(r.rcode).toBe(rcode);
  });
  it('SERVFAIL message is readable', () => {
    expect(classifyDohBody({ Status: 2 }, 'TXT').error).toBe('DNS SERVFAIL');
  });
  it.each([
    ['null body', null],
    ['array body', []],
    ['missing Status', {}],
    ['non-integer Status', { Status: 'x' }],
    ['Answer not an array', { Status: 0, Answer: 'nope' }],
    ['answer entry not an object', { Status: 0, Answer: ['x'] }],
    ['answer without data', { Status: 0, Answer: [{ type: 16 }] }],
  ])('malformed: %s → error', (_n, body) => {
    expect(classifyDohBody(body, 'TXT').status).toBe('error');
  });
});

describe('resolver error handling', () => {
  it('HTTP error → error', async () => {
    expect((await fakeResolver({ 'TXT a.com': 'HTTP500' }).txt('a.com')).status).toBe('error');
  });
  it('timeout/network failure → error', async () => {
    const r = await fakeResolver({ 'TXT a.com': 'TIMEOUT' }).txt('a.com');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/socket timeout/);
  });
  it('non-JSON body → error', async () => {
    expect((await fakeResolver({ 'TXT a.com': 'GARBAGE' }).txt('a.com')).status).toBe('error');
  });
  it('SERVFAIL → error', async () => {
    expect((await fakeResolver({ 'TXT a.com': 'SERVFAIL' }).txt('a.com')).status).toBe('error');
  });
  it('aborts a hung request after timeoutMs and reports a timeout error', async () => {
    const fetch = (_u: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const r = await createResolver({ fetch: fetch as never, timeoutMs: 10 }).txt('a.com');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/timeout/);
  });
  it('rejects unqueryable names as errors instead of "no record"', async () => {
    expect((await fakeResolver({}).txt('bad..name')).status).toBe('error');
    expect((await fakeResolver({}).txt('')).status).toBe('error');
  });
  it('NXDOMAIN and NODATA are distinct, non-error outcomes', async () => {
    const r = fakeResolver({ 'TXT empty.com': 'NODATA' });
    expect((await r.txt('empty.com')).status).toBe('nodata');
    expect((await r.txt('missing.com')).status).toBe('nxdomain');
  });
  it('lowercases and strips the trailing dot of the query name', async () => {
    const calls: string[] = [];
    await fakeResolver({}, calls).txt('Example.COM.');
    expect(calls).toEqual(['TXT example.com']);
  });
  it('uses the global fetch lazily when none is injected', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => resp(200, JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"hi"' }] }))) as never;
    try {
      expect((await createResolver().txt('a.com')).records).toEqual(['hi']);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('decodeTxtData', () => {
  it('strips quotes', () => expect(decodeTxtData('"v=spf1 -all"')).toBe('v=spf1 -all'));
  it('joins split character-strings', () => expect(decodeTxtData('"v=DKIM1; p=AAA" "BBB"')).toBe('v=DKIM1; p=AAABBB'));
  it('handles escaped quotes', () => expect(decodeTxtData('"a\\"b"')).toBe('a"b'));
  it('handles decimal escapes', () => expect(decodeTxtData('"a\\065b"')).toBe('aAb'));
  it('keeps embedded quotes-free unquoted data verbatim', () => expect(decodeTxtData('v=spf1 -all')).toBe('v=spf1 -all'));
  it('does not eat a legitimate leading/trailing quote pair inside the record', () => expect(decodeTxtData('"say \\"hi\\""')).toBe('say "hi"'));
});
