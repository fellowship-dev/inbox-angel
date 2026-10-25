/// <reference types="node" />
// U4: the report CLI. Drives the real entry point (`run`, which the bin calls) with an injected fake DoH fetch.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOH_ENDPOINTS, type FetchLike, type FetchResponseLike } from '@inbox-angel/dns-checks';
import { run } from '../cli';
import { REPORT_SCHEMA } from '../src/index';

const TYPE_CODE: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const ENDPOINTS = Object.values(DOH_ENDPOINTS);

function resp(status: number, body: string): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
}

type Zone = Record<string, string[]>;

/** A DoH fetch for every public endpoint, backed by `"TYPE name"` records. Domains in `dead` time out on every lookup. */
function fakeFetch(zone: Zone, opts: { dead?: string[]; calls?: string[] } = {}): FetchLike {
  return async url => {
    const endpoint = ENDPOINTS.find(e => url.startsWith(`${e}?`));
    if (!endpoint) return resp(404, 'not found'); // MTA-STS policy, BIMI assets
    const u = new URL(url);
    const name = u.searchParams.get('name')!;
    const type = u.searchParams.get('type')!;
    opts.calls?.push(`${endpoint} ${type} ${name}`);
    if (opts.dead?.some(d => name === d || name.endsWith(`.${d}`))) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const v = zone[`${type} ${name}`];
    if (!v) return resp(200, JSON.stringify({ Status: 3 }));
    return resp(200, JSON.stringify({ Status: 0, Answer: v.map(data => ({ name, type: TYPE_CODE[type], TTL: 60, data: type === 'TXT' ? `"${data}"` : data })) }));
  };
}

const ZONE: Zone = {
  'MX acme.dev': ['10 aspmx.l.google.com.'],
  'TXT acme.dev': ['v=spf1 include:_spf.google.com +all'],
  'NS acme.dev': ['ada.ns.cloudflare.com.', 'bob.ns.cloudflare.com.'],
  'TXT _spf.google.com': ['v=spf1 ip4:192.0.2.0/24 ~all'],
  'MX beta.io': ['10 aspmx.l.google.com.'],
  'TXT beta.io': ['v=spf1 include:_spf.google.com -all'],
  'TXT _dmarc.beta.io': ['v=DMARC1; p=none'],
  'NS beta.io': ['ns1.domaincontrol.com.'],
};

async function cli(argv: string[], fetch: FetchLike) {
  const lines: string[] = [];
  const code = await run(argv, { fetch, write: l => lines.push(l) });
  const out = lines.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { code, out, byDomain: Object.fromEntries(out.map(o => [o.domain, o])) };
}

describe('report CLI (U4)', () => {
  it('prints one line per domain with the model, HTML and Markdown, and the given token in each report URL', async () => {
    const calls: string[] = [];
    const tokens = { 'acme.dev': 'tokAcme_0123456789abcdef', 'beta.io': 'tokBeta-0123456789abcdef' };
    const { code, out, byDomain } = await cli(['acme.dev', 'beta.io', '--tokens', JSON.stringify(tokens)], fakeFetch(ZONE, { calls }));
    expect(code).toBe(0);
    expect(out).toHaveLength(2);
    for (const d of ['acme.dev', 'beta.io'] as const) {
      const line = byDomain[d];
      expect(Object.keys(line).sort()).toEqual(['domain', 'html', 'md', 'model', 'schema']);
      expect(line.schema).toBe(REPORT_SCHEMA);
      expect(line.model.schema).toBe(REPORT_SCHEMA);
      expect(line.model.domain).toBe(d);
      expect(line.model.reportUrl).toBe(`https://inboxangel.io/r/${tokens[d]}`);
      expect(line.model.resolvers).toBe(3);
      expect(line.html).toContain('<html');
      expect(line.md).toContain(`\`${d}\``);
      // NS and every check ran once against each of the three public resolvers (R10, R11)
      for (const e of ENDPOINTS) {
        expect(calls).toContain(`${e} NS ${d}`);
        expect(calls).toContain(`${e} TXT ${d}`);
      }
    }
    expect(byDomain['acme.dev'].model.dnsHost.id).toBe('cloudflare');
    expect(byDomain['acme.dev'].model.ns).toEqual(['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
    expect(byDomain['beta.io'].model.dnsHost.id).toBe('godaddy');
    const acmeIds = byDomain['acme.dev'].model.findings.map((f: { id: string; status: string }) => `${f.id}:${f.status}`);
    expect(acmeIds).toContain('spf-open:confirmed');
    expect(acmeIds).toContain('dmarc-missing:confirmed');
  });

  it('honours --report-url-base and never invents a report URL for a domain without a token', async () => {
    const { byDomain } = await cli(
      ['acme.dev', 'beta.io', '--report-url-base', 'https://example.test/reports/', '--tokens', JSON.stringify({ 'acme.dev': 'abc' })],
      fakeFetch(ZONE),
    );
    expect(byDomain['acme.dev'].model.reportUrl).toBe('https://example.test/reports/abc');
    expect(byDomain['beta.io'].model.reportUrl).toBeNull();
    expect(byDomain['beta.io'].html).not.toContain('/reports/');
  });

  it('reports a domain whose lookups all time out in its own line and still completes the other domain', async () => {
    const { code, out, byDomain } = await cli(['dead.dev', 'acme.dev', '--concurrency', '2'], fakeFetch(ZONE, { dead: ['dead.dev'] }));
    expect(code).toBe(0);
    expect(out).toHaveLength(2);
    const dead = byDomain['dead.dev'];
    expect(dead.schema).toBe(REPORT_SCHEMA);
    expect(dead.model.grade.level).toBeNull();
    expect(dead.model.lookupFailed.map((e: { check: string }) => e.check)).toEqual(expect.arrayContaining(['mx', 'spf', 'dmarc', 'ns']));
    for (const check of ['mx', 'spf', 'dmarc', 'ns']) expect(dead.model.lookupFailed.find((e: { check: string }) => e.check === check).runs).toBe(3);
    expect(dead.model.findings.filter((f: { status: string }) => f.status === 'confirmed')).toEqual([]);
    expect(dead.model.steps).toEqual([]);
    expect(byDomain['acme.dev'].model.findings.length).toBeGreaterThan(0);
  });

  it('normalizes a URL, a path and uppercase letters to the bare apex, once, and keys tokens the same way', async () => {
    const { out } = await cli(
      ['HTTPS://WWW.Acme.DEV/pricing?x=1', 'acme.dev.', 'http://beta.io:443/', '--tokens', JSON.stringify({ 'ACME.dev': 't1' })],
      fakeFetch(ZONE),
    );
    expect(out.map(o => o.domain).sort()).toEqual(['acme.dev', 'beta.io']);
    expect(out.find(o => o.domain === 'acme.dev').model.reportUrl).toBe('https://inboxangel.io/r/t1');
  });

  it('reads domains from --in and caller blocks from --blocks, inserting them into that domain\'s HTML only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ia-cli-'));
    const list = join(dir, 'domains.txt');
    const blocks = join(dir, 'blocks.json');
    writeFileSync(list, 'acme.dev\n\nbeta.io\n');
    writeFileSync(blocks, JSON.stringify({ 'acme.dev': [{ id: 'offer', html: '<section id="offer">We fix this for you.</section>' }] }));
    const { byDomain } = await cli(['--in', list, '--blocks', blocks], fakeFetch(ZONE));
    expect(Object.keys(byDomain).sort()).toEqual(['acme.dev', 'beta.io']);
    expect(byDomain['acme.dev'].html).toContain('<section id="offer">We fix this for you.</section>');
    expect(byDomain['acme.dev'].md).not.toContain('We fix this for you');
    expect(byDomain['beta.io'].html).not.toContain('id="offer"');
  });

  it('puts an input that is not a registrable domain in an error line instead of checking it', async () => {
    const calls: string[] = [];
    const { out, byDomain } = await cli(['co.uk', 'acme.dev'], fakeFetch(ZONE, { calls }));
    expect(out).toHaveLength(2);
    expect(byDomain['co.uk']).toEqual({ schema: REPORT_SCHEMA, domain: 'co.uk', error: expect.stringMatching(/not a registrable domain/) });
    expect(calls.some(c => c.endsWith(' co.uk'))).toBe(false);
  });

  it('exits 2 without checking anything on a usage error', async () => {
    const calls: string[] = [];
    expect((await cli([], fakeFetch(ZONE, { calls }))).code).toBe(2);
    expect((await cli(['acme.dev', '--tokens', '{not json'], fakeFetch(ZONE, { calls }))).code).toBe(2);
    expect((await cli(['acme.dev', '--concurrency', '0'], fakeFetch(ZONE, { calls }))).code).toBe(2);
    expect(calls).toEqual([]);
  });
});
