import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvObjects, toCsv } from '../../tools/audit-fleet/lib/csv';
import { parseShard, takeShard } from '../../tools/audit-fleet/lib/shard';
import { registrableDomain, candidateDomain, parsePsl, dedupeSeeds } from '../../tools/audit-fleet/lib/domain';
import { mergeReports } from '../../tools/audit-fleet/lib/io';
import { selectSeeds } from '../../tools/audit-fleet/lib/select';
import { DohClient } from '../../tools/audit-fleet/lib/doh';
import type { DomainReport } from '../../tools/audit-fleet/lib/checker';

describe('csv', () => {
  it('round-trips quotes, commas and newlines', () => {
    const rows = [['a,b', 'say "hi"', 'x\ny'], ['1', '', '3']];
    expect(parseCsv(toCsv(['h1', 'h2', 'h3'], rows)).slice(1)).toEqual(rows);
  });
  it('parses header rows to objects and tolerates CRLF', () => {
    expect(parseCsvObjects('domain,sources\r\nfoo.test,a|b\r\n')).toEqual([{ domain: 'foo.test', sources: 'a|b' }]);
  });
});

describe('shard', () => {
  it('parses and validates i/n', () => {
    expect(parseShard('2/4')).toEqual({ index: 2, total: 4 });
    for (const bad of ['0/4', '5/4', 'x', '1/0', '1-4']) expect(() => parseShard(bad)).toThrow();
  });
  it('shards are disjoint, cover the input, and are balanced', () => {
    const items = Array.from({ length: 103 }, (_, i) => `d${i}`);
    const parts = [1, 2, 3, 4].map(i => takeShard(items, { index: i, total: 4 }));
    expect(parts.flat().sort()).toEqual([...items].sort());
    expect(new Set(parts.flat()).size).toBe(items.length);
    const sizes = parts.map(p => p.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});

describe('domains', () => {
  const psl = parsePsl('// ===BEGIN ICANN DOMAINS===\ncom\nuk\nco.uk\n*.ck\n!www.ck\n// ===BEGIN PRIVATE DOMAINS===\nvercel.app\n');
  it('finds the registrable domain, incl. multi-label suffixes and wildcards', () => {
    expect(registrableDomain('a.b.example.com', psl)).toBe('example.com');
    expect(registrableDomain('shop.example.co.uk', psl)).toBe('example.co.uk');
    expect(registrableDomain('co.uk', psl)).toBeNull();
    expect(registrableDomain('x.foo.ck', psl)).toBe('x.foo.ck');
    expect(registrableDomain('www.ck', psl)).toBe('www.ck');
    expect(registrableDomain('1.2.3.4', psl)).toBeNull();
  });
  it('ignores the PSL private section (platform filtering is separate)', () => {
    expect(registrableDomain('app.vercel.app', psl)).toBe('vercel.app');
  });
  it('drops platform subdomains and non-product hosts, strips www', () => {
    expect(candidateDomain('https://my-app.vercel.app/x', psl)).toEqual({ drop: 'platform' });
    expect(candidateDomain('https://foo.lovable.app', psl)).toEqual({ drop: 'platform' });
    expect(candidateDomain('https://user.github.io/repo', psl)).toEqual({ drop: 'platform' });
    expect(candidateDomain('https://github.com/a/b', psl)).toEqual({ drop: 'non-product' });
    expect(candidateDomain('https://www.cool-thing.com/pricing?x=1', psl)).toEqual({ domain: 'cool-thing.com' });
    expect(candidateDomain('docs.cool-thing.com', psl)).toEqual({ domain: 'cool-thing.com' });
    expect(candidateDomain('not a url', psl)).toEqual({ drop: 'invalid' });
  });
  it('dedupes and records every source', () => {
    expect(dedupeSeeds([{ domain: 'a.com', source: 'hn' }, { domain: 'a.com', source: 'gh' }, { domain: 'b.com', source: 'hn' }]))
      .toEqual([{ domain: 'a.com', sources: ['hn', 'gh'] }, { domain: 'b.com', sources: ['hn'] }]);
  });
});

describe('selectSeeds', () => {
  const raw = [
    ...Array.from({ length: 50 }, (_, i) => ({ domain: `h${i}.test`, source: 'hn-show', ref: 'win:1' })),
    ...Array.from({ length: 50 }, (_, i) => ({ domain: `w${i}.test`, source: 'hn-workingon', ref: 't' })),
    { domain: 'both.test', source: 'hn-show', ref: 'win:1' }, { domain: 'both.test', source: 'github', ref: 'q' },
    { domain: 'kw.test', source: 'hn-show', ref: 'kw:resend' },
  ];
  it('caps at target, is deterministic, always keeps multi-source and keyword hits', () => {
    const a = selectSeeds(raw, 20), b = selectSeeds([...raw].reverse(), 20);
    expect(a).toHaveLength(20);
    expect(a).toEqual(b);
    const names = a.map(s => s.domain);
    expect(names).toContain('both.test');
    expect(names).toContain('kw.test');
    expect(a.find(s => s.domain === 'both.test')!.sources).toEqual(['github', 'hn-show']);
  });
  it('mixes HN sources when filling', () => {
    const a = selectSeeds(raw, 30).map(s => s.domain);
    expect(a.some(d => d.startsWith('h'))).toBe(true);
    expect(a.some(d => d.startsWith('w'))).toBe(true);
  });
});

const rep = (domain: string, errors: string[] = [], over: Partial<DomainReport> = {}): DomainReport => ({
  domain, checkedAt: 't', errors, exists: true, spf: { present: false }, dmarc: { present: false },
  dkim: { found: false, selectors: [] }, mx: { present: false, hosts: [] }, dnsHost: null, senders: [], mtaSts: false, ...over,
});

describe('mergeReports', () => {
  it('dedupes by domain, sorts, and prefers a clean result over a later errored one', () => {
    const merged = mergeReports([[rep('b.test'), rep('a.test', ['txt:timeout'])], [rep('a.test'), rep('b.test', ['mx:timeout'])]]);
    expect(merged.map(r => r.domain)).toEqual(['a.test', 'b.test']);
    expect(merged.every(r => r.errors.length === 0)).toBe(true);
  });
});

describe('DohClient', () => {
  const mk = (responses: (() => Response | Promise<Response>)[], over = {}) => {
    let i = 0;
    return new DohClient({ rps: 1000, resolvers: ['https://r1/', 'https://r2/'], retries: 2, timeoutMs: 1000,
      fetchImpl: (async () => responses[Math.min(i++, responses.length - 1)]()) as unknown as typeof fetch, ...over });
  };
  const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status });
  it('retries 5xx then succeeds', async () => {
    const c = mk([json({}, 503), json({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 " "-all"' }] })]);
    const r = await c.txt('x.test');
    expect(r.ok).toBe(true);
    expect(r.records).toEqual(['v=spf1 -all']);
    expect(c.stats.retries).toBe(1);
  }, 10_000);
  it('treats NXDOMAIN as a definitive answer, not an error', async () => {
    const c = mk([json({ Status: 3 })]);
    const r = await c.txt('x.test');
    expect(r).toMatchObject({ ok: true, status: 3, records: [] });
    expect(c.stats.failures).toBe(0);
  });
  it('reports failure after exhausting retries', async () => {
    const c = mk([json({}, 500)]);
    const r = await c.txt('x.test');
    expect(r.ok).toBe(false);
    expect(c.stats.failures).toBe(1);
  }, 20_000);
  it('rate-limits to rps', async () => {
    const c = mk([json({ Status: 0 })], { rps: 20 });
    const t = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => c.txt('x.test')));
    expect(Date.now() - t).toBeGreaterThanOrEqual(230); // 5 intervals of 50ms
  });
});
