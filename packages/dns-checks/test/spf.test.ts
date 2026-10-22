import { describe, it, expect } from 'vitest';
import { analyzeSpf, analyzeSpfRecord, buildFlatRecord, collectIps, parseSpfRecord, previewFlatten, isSpfRecord } from '../src/spf';
import { fakeResolver, type Zone } from './helpers';

const txt = (...v: string[]) => v;

describe('parseSpfRecord', () => {
  it('verdicts by qualifier of all', () => {
    expect(parseSpfRecord('v=spf1 -all').verdict).toBe('strict');
    expect(parseSpfRecord('v=spf1 ~all').verdict).toBe('soft');
    expect(parseSpfRecord('v=spf1 +all').verdict).toBe('open');
    expect(parseSpfRecord('v=spf1 all').verdict).toBe('open');
    expect(parseSpfRecord('v=spf1 ?all').verdict).toBe('open');
    expect(parseSpfRecord('v=spf1 a').verdict).toBe('missing');
  });
  it('does not mistake mechanisms that merely end in "all" for the all mechanism', () => {
    expect(parseSpfRecord('v=spf1 include:mail.ball ip4:1.2.3.4 a:small -all').verdict).toBe('strict');
    expect(parseSpfRecord('v=spf1 a:ball').verdict).toBe('missing');
  });
  it('parses qualifiers, cidr and modifiers', () => {
    const t = parseSpfRecord('v=spf1 -mx:mail.x.com/24//64 ~include:y.com redirect=z.com exp=e.com').terms;
    expect(t[0]).toMatchObject({ name: 'mx', qualifier: '-', value: 'mail.x.com', cidr4: 24, cidr6: 64 });
    expect(t[1]).toMatchObject({ name: 'include', qualifier: '~', value: 'y.com' });
    expect(t[2]).toMatchObject({ kind: 'modifier', name: 'redirect', value: 'z.com' });
  });
  it('isSpfRecord requires v=spf1 as a whole word', () => {
    expect(isSpfRecord('v=spf1 -all')).toBe(true);
    expect(isSpfRecord('V=SPF1')).toBe(true);
    expect(isSpfRecord('v=spf10 -all')).toBe(false);
    expect(isSpfRecord('v=spf1-all')).toBe(false);
  });
});

describe('analyzeSpf – status classification', () => {
  it('NXDOMAIN and NODATA → none', async () => {
    expect((await analyzeSpf('x.com', fakeResolver({}))).status).toBe('none');
    expect((await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': 'NODATA' }))).status).toBe('none');
  });
  it('TXT without v=spf1 → none', async () => {
    expect((await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('hello') }))).status).toBe('none');
  });
  it.each(['SERVFAIL', 'TIMEOUT', 'HTTP500', 'GARBAGE'] as const)('%s on the root lookup → temperror, never none', async f => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': f }));
    expect(a.status).toBe('temperror');
    expect(a.record).toBeNull();
  });
  it('DNS error inside an include → temperror (not silently counted as fine)', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 include:y.com -all'), 'TXT y.com': 'SERVFAIL' }));
    expect(a.status).toBe('temperror');
  });
  it('multiple SPF records → permerror', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 -all', 'v=spf1 +all') }));
    expect(a.status).toBe('permerror');
    expect(a.issues[0].code).toBe('multiple-records');
  });
  it('multiple SPF records inside an include → permerror', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 include:y.com -all'), 'TXT y.com': txt('v=spf1 -all', 'v=spf1 ~all') }));
    expect(a.status).toBe('permerror');
  });
  it('one SPF record next to other TXT records is fine', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('google-site-verification=abc', 'v=spf1 ip4:1.2.3.4 -all') }));
    expect(a.status).toBe('ok');
    expect(a.record?.verdict).toBe('strict');
  });
  it('include of a domain with no SPF → permerror', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 include:gone.com -all') }));
    expect(a.status).toBe('permerror');
    expect(a.issues.some(i => i.code === 'include-no-record')).toBe(true);
  });
  it('unknown mechanism → permerror', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 foo:bar -all') }));
    expect(a.status).toBe('permerror');
  });
});

describe('analyzeSpf – lookup counting (RFC 7208 §4.6.4)', () => {
  const count = async (record: string, extra: Zone = {}) =>
    (await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt(record), ...extra }))).lookupCount;

  it('ip4, ip6 and all do not count', async () => {
    expect(await count('v=spf1 ip4:1.2.3.4 ip4:10.0.0.0/8 ip6:2001:db8::/32 -all')).toBe(0);
  });
  it('include, a, mx, ptr, exists each count 1', async () => {
    const z: Zone = { 'TXT y.com': txt('v=spf1 -all') };
    expect(await count('v=spf1 include:y.com -all', z)).toBe(1);
    expect(await count('v=spf1 a -all')).toBe(1);
    expect(await count('v=spf1 a:foo.com/24 -all')).toBe(1);
    expect(await count('v=spf1 mx -all')).toBe(1);
    expect(await count('v=spf1 mx/24 -all')).toBe(1);
    expect(await count('v=spf1 ptr -all')).toBe(1);
    expect(await count('v=spf1 ptr:foo.com -all')).toBe(1);
    expect(await count('v=spf1 exists:%{i}.rbl.example.com -all')).toBe(1);
  });
  it('redirect counts 1 when there is no all', async () => {
    expect(await count('v=spf1 redirect=y.com', { 'TXT y.com': txt('v=spf1 ip4:1.2.3.4 -all') })).toBe(1);
  });
  it('redirect is ignored (and costs nothing) when an all mechanism is present', async () => {
    const calls: string[] = [];
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 redirect=y.com -all') }, calls));
    expect(a.lookupCount).toBe(0);
    expect(calls).not.toContain('TXT y.com');
  });
  it('exp= does not count and is not resolved', async () => {
    const calls: string[] = [];
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 exp=why.x.com -all') }, calls));
    expect(a.lookupCount).toBe(0);
    expect(calls).toEqual(['TXT x.com']);
  });
  it('counts nested includes recursively and each occurrence', async () => {
    const z: Zone = {
      'TXT x.com': txt('v=spf1 include:a.com include:b.com -all'),
      'TXT a.com': txt('v=spf1 include:c.com ip4:1.1.1.1 -all'),
      'TXT b.com': txt('v=spf1 include:c.com -all'),
      'TXT c.com': txt('v=spf1 ip4:2.2.2.2 -all'),
    };
    const a = await analyzeSpf('x.com', fakeResolver(z));
    expect(a.lookupCount).toBe(4); // a, c, b, c
    expect(a.status).toBe('ok');
  });
  it('exactly 10 is fine, 11 is permerror', async () => {
    const ten = 'v=spf1 ' + Array.from({ length: 10 }, (_, i) => `ip4:1.1.1.${i}`).join(' ') + ' ' + Array.from({ length: 10 }, (_, i) => `exists:e${i}.com`).join(' ') + ' -all';
    const zone10: Zone = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`A e${i}.com`, ['1.2.3.4']]));
    const a10 = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt(ten), ...zone10 }));
    expect(a10.lookupCount).toBe(10);
    expect(a10.status).toBe('ok');
    expect(a10.lookupLimitExceeded).toBe(false);

    const eleven = ten.replace(' -all', ' exists:e10.com -all');
    const a11 = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt(eleven), ...zone10, 'A e10.com': ['1.2.3.4'] }));
    expect(a11.lookupCount).toBe(11);
    expect(a11.lookupLimitExceeded).toBe(true);
    expect(a11.status).toBe('permerror');
    expect(a11.issues.some(i => i.code === 'lookup-limit')).toBe(true);
  });
  it('the limit is global across nested includes', async () => {
    const z: Zone = { 'TXT x.com': txt('v=spf1 include:a.com include:b.com -all') };
    z['TXT a.com'] = txt('v=spf1 ' + Array.from({ length: 5 }, (_, i) => `exists:a${i}.com`).join(' ') + ' -all');
    z['TXT b.com'] = txt('v=spf1 ' + Array.from({ length: 5 }, (_, i) => `exists:b${i}.com`).join(' ') + ' -all');
    for (const p of ['a', 'b']) for (let i = 0; i < 5; i++) z[`A ${p}${i}.com`] = ['1.2.3.4'];
    const a = await analyzeSpf('x.com', fakeResolver(z));
    expect(a.lookupCount).toBe(11); // evaluation stops as soon as the limit is exceeded
    expect(a.lookupLimitExceeded).toBe(true);
    expect(a.status).toBe('permerror');
  });
  it('does not blow up on a very long include chain (stops at the limit)', async () => {
    const z: Zone = {};
    for (let i = 0; i < 40; i++) z[`TXT d${i}.com`] = txt(`v=spf1 include:d${i + 1}.com -all`);
    const calls: string[] = [];
    const a = await analyzeSpf('d0.com', fakeResolver(z, calls));
    expect(a.status).toBe('permerror');
    expect(a.lookupCount).toBe(11);
    expect(calls.length).toBeLessThanOrEqual(12);
  });
  it('analyzeSpfRecord counts an unpublished record', async () => {
    const a = await analyzeSpfRecord('v=spf1 include:y.com mx -all', fakeResolver({ 'TXT y.com': txt('v=spf1 a ip4:1.1.1.1 -all'), 'A y.com': ['1.1.1.1'], 'MX x.com': ['10 m.x.com.'] }), 'x.com');
    expect(a.lookupCount).toBe(3);
  });
  it('analyzeSpfRecord rejects non-SPF input', async () => {
    expect((await analyzeSpfRecord('hello', fakeResolver({}))).status).toBe('permerror');
  });
});

describe('analyzeSpf – void lookups (limit 2)', () => {
  it('two voids are tolerated, a third is a permerror', async () => {
    const two = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 exists:a.com exists:b.com ip4:1.1.1.1 -all') }));
    expect(two.voidLookupCount).toBe(2);
    expect(two.voidLimitExceeded).toBe(false);
    expect(two.status).toBe('ok');

    const three = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 exists:a.com exists:b.com exists:c.com -all') }));
    expect(three.voidLookupCount).toBe(3);
    expect(three.voidLimitExceeded).toBe(true);
    expect(three.status).toBe('permerror');
    expect(three.issues.some(i => i.code === 'void-lookup-limit')).toBe(true);
  });
  it('NODATA (NOERROR, empty) counts as void like NXDOMAIN', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({
      'TXT x.com': txt('v=spf1 exists:a.com exists:b.com exists:c.com -all'),
      'A a.com': 'NODATA', 'A b.com': 'NODATA', 'A c.com': 'NODATA',
    }));
    expect(a.voidLookupCount).toBe(3);
  });
  it('mx with no MX records is void; a host with A or AAAA is not', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({
      'TXT x.com': txt('v=spf1 mx a:v6.com a:none.com -all'),
      'AAAA v6.com': ['2001:db8::1'],
    }));
    expect(a.voidLookupCount).toBe(2); // mx x.com + a:none.com
  });
  it('a SERVFAIL on a/mx/exists is an error, not a void lookup', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 exists:a.com -all'), 'A a.com': 'SERVFAIL' }));
    expect(a.voidLookupCount).toBe(0);
    expect(a.status).toBe('temperror');
  });
  it('an mx mechanism resolving more than 10 hosts is a permerror', async () => {
    const hosts = Array.from({ length: 11 }, (_, i) => `${i} m${i}.x.com.`);
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 mx -all'), 'MX x.com': hosts }));
    expect(a.status).toBe('permerror');
    expect(a.issues[0].code).toBe('mx-name-limit');
  });
});

describe('analyzeSpf – loops', () => {
  it('direct self-include is detected', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 include:x.com -all') }));
    expect(a.status).toBe('permerror');
    expect(a.issues[0].code).toBe('loop');
  });
  it('indirect loop a → b → a is detected', async () => {
    const a = await analyzeSpf('a.com', fakeResolver({ 'TXT a.com': txt('v=spf1 include:b.com -all'), 'TXT b.com': txt('v=spf1 include:a.com -all') }));
    expect(a.status).toBe('permerror');
    expect(a.issues[0]).toMatchObject({ code: 'loop' });
    expect(a.issues[0].message).toContain('a.com → b.com → a.com');
  });
  it('redirect loops are detected', async () => {
    const a = await analyzeSpf('a.com', fakeResolver({ 'TXT a.com': txt('v=spf1 redirect=b.com'), 'TXT b.com': txt('v=spf1 redirect=a.com') }));
    expect(a.status).toBe('permerror');
    expect(a.issues.some(i => i.code === 'loop')).toBe(true);
  });
  it('including the same domain twice (diamond) is NOT a loop', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({
      'TXT x.com': txt('v=spf1 include:a.com include:a.com -all'),
      'TXT a.com': txt('v=spf1 ip4:1.1.1.1 -all'),
    }));
    expect(a.status).toBe('ok');
    expect(a.lookupCount).toBe(2);
  });
  it('is case-insensitive when matching loop targets', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 include:X.COM -all') }));
    expect(a.issues[0].code).toBe('loop');
  });
});

describe('flatten preview', () => {
  const zone: Zone = {
    'TXT x.com': txt('v=spf1 include:a.com include:b.com mx ip4:9.9.9.9 -all'),
    'TXT a.com': txt('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 ip6:2001:db8::/32 ~all'),
    'TXT b.com': txt('v=spf1 ip4:1.1.1.1 include:c.com -all'),
    'TXT c.com': txt('v=spf1 ip4:3.3.3.3 -all'),
  };
  it('collects deduplicated IPs, keeps mx, and takes `all` from the root only', async () => {
    const r = await collectIps('x.com', fakeResolver(zone));
    expect(r.ips).toEqual(['ip4:1.1.1.1', 'ip4:1.1.1.2', 'ip6:2001:db8::/32', 'ip4:3.3.3.3', 'ip4:9.9.9.9']);
    expect(r.extra).toEqual(['mx']);
    expect(r.allQualifier).toBe('-all');
    expect(r.errors).toEqual([]);
  });
  it('follows redirect= for the terminal all', async () => {
    const r = await collectIps('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 ip4:1.1.1.1 redirect=y.com'), 'TXT y.com': txt('v=spf1 ip4:2.2.2.2 -all') }));
    expect(r.ips).toEqual(['ip4:1.1.1.1', 'ip4:2.2.2.2']);
    expect(r.allQualifier).toBe('-all');
  });
  it('keeps qualifiers on ip mechanisms and non-pass includes verbatim', async () => {
    const r = await collectIps('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 -ip4:1.1.1.1 +ip4:2.2.2.2 ~include:y.com -all') }));
    expect(r.ips).toEqual(['-ip4:1.1.1.1', 'ip4:2.2.2.2']);
    expect(r.extra).toEqual(['~include:y.com']);
  });
  it('a DNS error makes the result incomplete instead of silently dropping the include', async () => {
    const p = await previewFlatten('x.com', fakeResolver({ ...zone, 'TXT a.com': 'SERVFAIL' }));
    expect(p.incomplete).toBe(true);
    expect(p.errors[0].code).toBe('dns-error');
  });
  it('multiple SPF records and loops make the result incomplete', async () => {
    expect((await previewFlatten('x.com', fakeResolver({ ...zone, 'TXT c.com': txt('v=spf1 -all', 'v=spf1 -all') }))).incomplete).toBe(true);
    expect((await previewFlatten('a.com', fakeResolver({ 'TXT a.com': txt('v=spf1 include:b.com -all'), 'TXT b.com': txt('v=spf1 include:a.com -all') }))).incomplete).toBe(true);
  });
  it('reports remaining lookups, size and splitting', async () => {
    const p = await previewFlatten('x.com', fakeResolver(zone));
    expect(p.remainingLookups).toBe(1);
    expect(p.flattenedRecord).toBe('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 ip6:2001:db8::/32 ip4:3.3.3.3 ip4:9.9.9.9 mx -all');
    expect(p.needsSplitting).toBe(false);
    const many = 'v=spf1 ' + Array.from({ length: 40 }, (_, i) => `ip4:10.0.${i}.1`).join(' ') + ' -all';
    expect((await previewFlatten('y.com', fakeResolver({ 'TXT y.com': txt(many) }))).needsSplitting).toBe(true);
  });
  it('buildFlatRecord dedupes', () => {
    expect(buildFlatRecord(['ip4:1.1.1.1', 'ip4:1.1.1.1'], ['mx'], '~all')).toBe('v=spf1 ip4:1.1.1.1 mx ~all');
  });
});

describe('void lookups on MX hosts (RFC 7208 §4.6.4)', () => {
  it('MX hosts without addresses count as void lookups', async () => {
    const z: Zone = { 'TXT x.com': txt('v=spf1 mx -all'), 'MX x.com': ['10 a.x.com.', '20 b.x.com.', '30 c.x.com.'] };
    const a = await analyzeSpf('x.com', fakeResolver(z));
    expect(a.voidLookupCount).toBe(3);
    expect(a.status).toBe('permerror');
    expect(a.issues.some(i => i.code === 'void-lookup-limit')).toBe(true);
  });
  it('MX hosts with A or AAAA records are not void; DNS errors on them are errors', async () => {
    const z: Zone = { 'TXT x.com': txt('v=spf1 mx -all'), 'MX x.com': ['10 a.x.com.', '20 b.x.com.'], 'A a.x.com': ['1.2.3.4'], 'AAAA b.x.com': ['2001:db8::1'] };
    expect((await analyzeSpf('x.com', fakeResolver(z))).voidLookupCount).toBe(0);
    const e = await analyzeSpf('x.com', fakeResolver({ ...z, 'A b.x.com': 'SERVFAIL' }));
    expect(e.status).toBe('temperror');
  });
  it('multiple SPF records expose rawRecords', async () => {
    const a = await analyzeSpf('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 -all', 'v=spf1 ~all') }));
    expect(a.rawRecords).toEqual(['v=spf1 -all', 'v=spf1 ~all']);
  });
});

describe('flatten: terms copied from include targets', () => {
  it('pins bare a/mx/ptr (and cidr) to the include domain, not the customer domain', async () => {
    const r = await collectIps('x.com', fakeResolver({
      'TXT x.com': txt('v=spf1 include:vendor.com a -all'),
      'TXT vendor.com': txt('v=spf1 a mx/24 ~ptr ip4:1.1.1.1 -all'),
    }));
    expect(r.extra).toEqual(['a:vendor.com', 'mx:vendor.com/24', '~ptr:vendor.com', 'a']);
    expect(r.errors).toEqual([]);
  });
  it('keeps explicit targets and the root bare a untouched', async () => {
    const r = await collectIps('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 a mx:mail.x.com -all') }));
    expect(r.extra).toEqual(['a', 'mx:mail.x.com']);
  });
  it('does not lowercase macros', async () => {
    const r = await collectIps('x.com', fakeResolver({ 'TXT x.com': txt('v=spf1 exists:%{I}._spf.Vendor.com -all') }));
    expect(r.extra).toEqual(['exists:%{I}._spf.Vendor.com']);
  });
});
