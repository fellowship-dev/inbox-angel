import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));

import { discoverMxHosts, detectExistingMtaStsMode, buildPolicyFile, generatePolicyId } from '../../src/email/mta-sts';
import { collectIps, buildFlatRecord } from '../../src/email/spf-flattener';

const doh = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stub(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url.toString());
    const key = `${u.searchParams.get('type')} ${u.searchParams.get('name')}`;
    if (!u.hostname.includes('cloudflare-dns')) return new Response('nf', { status: 404 });
    const v = map[key];
    if (v instanceof Error) throw v;
    return doh(v ?? { Status: 3 });
  }));
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('mta-sts worker module (pure parts come from the package)', () => {
  it('discoverMxHosts returns hosts, [] for no MX, and THROWS on DNS error', async () => {
    stub({ 'MX x.com': { Status: 0, Answer: [{ type: 15, data: '20 b.x.com.' }, { type: 15, data: '10 a.x.com.' }] } });
    expect(await discoverMxHosts('x.com')).toEqual(['a.x.com', 'b.x.com']);
    stub({});
    expect(await discoverMxHosts('x.com')).toEqual([]);
    stub({ 'MX x.com': { Status: 2 } });
    await expect(discoverMxHosts('x.com')).rejects.toThrow(/MX lookup/);
    stub({ 'MX x.com': new Error('timeout') });
    await expect(discoverMxHosts('x.com')).rejects.toThrow(/MX lookup/);
  });

  it('detectExistingMtaStsMode: null when nothing published, throws on DNS error (never "testing" by accident)', async () => {
    stub({});
    expect(await detectExistingMtaStsMode('x.com')).toBeNull();
    stub({ 'TXT _mta-sts.x.com': { Status: 2 } });
    await expect(detectExistingMtaStsMode('x.com')).rejects.toThrow();
  });

  it('re-exports the package policy helpers', () => {
    expect(buildPolicyFile('enforce', ['mx.x.com'], 86400)).toContain('mode: enforce');
    expect(generatePolicyId()).toMatch(/^\d{14}$/);
  });
});

describe('spf-flattener worker module', () => {
  it('collectIps refuses to return a partial result when a nested include fails', async () => {
    stub({
      'TXT x.com': { Status: 0, Answer: [{ type: 16, data: '"v=spf1 include:a.com include:b.com -all"' }] },
      'TXT a.com': { Status: 0, Answer: [{ type: 16, data: '"v=spf1 ip4:1.1.1.1 -all"' }] },
      'TXT b.com': { Status: 2 },
    });
    await expect(collectIps('x.com')).rejects.toThrow(/Could not fully resolve SPF for x\.com/);
  });

  it('collectIps resolves a complete chain', async () => {
    stub({
      'TXT x.com': { Status: 0, Answer: [{ type: 16, data: '"v=spf1 include:a.com -all"' }] },
      'TXT a.com': { Status: 0, Answer: [{ type: 16, data: '"v=spf1 ip4:1.1.1.1 ip6:2001:db8::/32 ~all"' }] },
    });
    const r = await collectIps('x.com');
    expect(buildFlatRecord(r.ips, r.extra, r.allQualifier)).toBe('v=spf1 ip4:1.1.1.1 ip6:2001:db8::/32 -all');
  });
});

describe('packages/dns-checks stays pure', () => {
  const dir = join(__dirname, '../../packages/dns-checks/src');
  const files = readdirSync(dir).filter(f => f.endsWith('.ts'));

  it('has source files', () => expect(files.length).toBeGreaterThan(8));

  it.each(files)('%s has no worker/D1/Cloudflare-API dependencies', file => {
    const src = readFileSync(join(dir, file), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    for (const spec of imports) {
      expect(spec.startsWith('./') || spec === 'tldts', `${file} imports ${spec}`).toBe(true);
    }
    expect(src).not.toMatch(/D1Database|api\.cloudflare\.com|CLOUDFLARE_|env-utils|process\.env/);
  });
});
