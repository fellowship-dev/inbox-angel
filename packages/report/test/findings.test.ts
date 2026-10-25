// Port of unzip-inboxangel outreach-tools/tests/test_mail_check.py and the finding half of test_bimi.py.
import { describe, expect, it } from 'vitest';
import { build, factsOf, findingsOf, pctOf, type Finding } from '../src/index';
import { CHECKED, GOOGLE, RESEND, SES, bimiRec, makeRec, type RecOptions } from './helpers';
import type { DomainReport } from '@inbox-angel/dns-checks';

const ids = (r: DomainReport): Record<string, Finding> => Object.fromEntries(findingsOf(r, CHECKED).map(f => [f.id, f]));
const SPF = 'v=spf1 include:_spf.google.com ~all';

describe('mail findings (test_mail_check.py)', () => {
  it('missing SPF and DMARC are high-confidence facts', () => {
    const got = ids(makeRec('acme.dev', { providers: [GOOGLE] }));
    expect(Object.keys(got)).toEqual(expect.arrayContaining(['spf-missing', 'dmarc-missing']));
    const f = got['dmarc-missing'];
    for (const key of ['id', 'title', 'area', 'severity', 'effort', 'impact', 'confidence', 'evidence', 'recommendation'] as const) {
      expect([null, undefined, ''].includes(f[key] as never)).toBe(false);
    }
    expect(f.evidence.length).toBeGreaterThan(0);
    expect(f.severity).toBe('high');
    expect(f.effort).toBe('S');
    expect(f.confidence).toBeGreaterThanOrEqual(0.9);
    expect(f.evidence[0]).toContain('_dmarc.acme.dev');
    expect(f.evidence[0]).toContain('2026-10-22');
    expect(got['spf-missing'].confidence).toBe(0.95); // a mailbox provider sends as the apex
    expect(ids(makeRec('acme.dev'))['spf-missing'].confidence).toBe(0.8);
  });

  it('DKIM not found is a hint below 0.5 confidence, never a confirmed finding (SES lowest)', () => {
    const rec = makeRec('acme.dev', {
      spf: 'ok', spfRaw: 'v=spf1 include:amazonses.com ~all', spfIncludes: ['amazonses.com'], providers: [SES],
      dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none; rua=mailto:a@acme.dev', rua: ['mailto:a@acme.dev'], mx: ['none', []],
    });
    const f = ids(rec)['dkim-not-found-for-sender'];
    expect(f.confidence).toBeLessThanOrEqual(0.2);
    expect(f.evidence.join(' ')).toContain('not proof');
    expect(f.provider).toBe('amazon-ses');
    const resend = makeRec('acme.dev', {
      spf: 'ok', spfRaw: 'v=spf1 include:resend.com ~all', providers: [RESEND], dmarc: 'found',
      dmarcRaw: 'v=DMARC1; p=none; rua=mailto:a@acme.dev', rua: ['mailto:a@acme.dev'], mx: ['none', []],
    });
    expect(ids(resend)['dkim-not-found-for-sender'].confidence).toBeLessThanOrEqual(0.5);
  });

  it('a found DKIM key clears the DKIM finding', () => {
    const rec = makeRec('example.com', {
      spf: 'ok', spfRaw: 'v=spf1 include:resend.com ~all', providers: [RESEND], dkim: ['resend'], dmarc: 'found',
      dmarcRaw: 'v=DMARC1; p=none; rua=mailto:a@x.io', rua: ['mailto:a@x.io'], mx: ['none', []],
    });
    expect(ids(rec)['dkim-not-found-for-sender']).toBeUndefined();
  });

  it('a provider-specific DKIM selector identifies the sender', () => {
    const facts = factsOf(makeRec('example.com', { dkim: ['resend', 'google'] }), CHECKED);
    expect(facts.senderProviders.map(p => p.id)).toEqual(['resend']);
    expect(facts.mailboxProviders.map(p => p.id)).toEqual(['google-workspace']);
  });

  it('multiple SPF, over 10 lookups and permerror', () => {
    const two = ids(makeRec('example.com', {
      spf: 'permerror', spfRaws: ['v=spf1 include:_spf.google.com ~all', 'v=spf1 include:amazonses.com -all'],
      spfIssues: [{ code: 'multiple-records', domain: 'example.com', message: '2 records' }],
    }));
    expect(two['multiple-spf']).toBeDefined();
    expect(two['spf-permerror']).toBeUndefined();
    const big = ids(makeRec('example.com', {
      spf: 'permerror', spfRaw: 'v=spf1 include:a.com ~all', lookups: 11, spfIncludes: ['a.com'],
      spfIssues: [{ code: 'lookup-limit', domain: 'example.com', message: '11 lookups' }],
    }))['spf-over-10-lookups'];
    expect(big.title).toContain('11');
    expect(big.confidence).toBeGreaterThanOrEqual(0.9);
    const loop = ids(makeRec('example.com', { spf: 'permerror', spfIssues: [{ code: 'include-no-record', domain: 'example.com', message: 'include:gone.example has no SPF' }] }));
    expect(loop['spf-permerror'].evidence.join(' ')).toContain('include:gone.example has no SPF');
    const nested = ids(makeRec('example.com', {
      spf: 'permerror', spfRaws: ['v=spf1 -all', 'v=spf1 ~all'], spfIssues: [{ code: 'multiple-records', domain: 'other.example', message: 'nested' }],
    }));
    expect(nested['multiple-spf']).toBeUndefined(); // duplicates in somebody else's include are not the prospect's record
  });

  it('DMARC variants', () => {
    expect(ids(makeRec('example.com', { dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none', spf: 'ok', spfRaw: 'v=spf1 ~all' }))['dmarc-p-none-no-rua'].impact).toBeLessThan(0.5);
    expect(ids(makeRec('example.com', { dmarc: 'multiple', dmarcRaws: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }))['dmarc-multiple']).toBeDefined();
    expect(ids(makeRec('example.com', { dmarc: 'found', dmarcRaw: 'v=DMARC1; p=bogus', valid: false }))['dmarc-invalid']).toBeDefined();
    const enforced = ids(makeRec('example.com', { dmarc: 'found', dmarcRaw: 'v=DMARC1; p=reject; rua=mailto:a@x.io', dmarcPolicy: 'reject', rua: ['mailto:a@x.io'] }));
    expect(Object.keys(enforced).filter(i => i.startsWith('dmarc'))).toEqual([]);
  });

  it('+all yields spf-open; a record with no all term yields spf-no-all', () => {
    expect(ids(makeRec('example.com', { spf: 'ok', spfRaw: 'v=spf1 +all', verdict: 'open' }))['spf-open']).toBeDefined();
    expect(ids(makeRec('example.com', { spf: 'ok', spfRaw: 'v=spf1 include:x.com', verdict: 'missing' }))['spf-no-all']).toBeDefined();
  });

  it('MTA-STS missing is low', () => {
    const f = ids(makeRec('example.com', { providers: [GOOGLE] }))['mta-sts-missing'];
    expect(f.severity).toBe('low');
    expect(f.impact).toBeLessThanOrEqual(0.15);
  });

  it('DNS lookup errors go to unchecked, never to findings', () => {
    const rec = makeRec('example.com', { spf: 'temperror', dmarc: 'error', errors: [{ check: 'spf', message: 'SERVFAIL' }] });
    expect(Object.keys(ids(rec)).filter(i => i.startsWith('spf') || i.startsWith('dmarc'))).toEqual([]);
    expect(factsOf(rec, CHECKED).unchecked.some(u => u.includes('SERVFAIL'))).toBe(true);
  });

  it('unchecked always lists the limits', () => {
    const unchecked = factsOf(makeRec(), CHECKED).unchecked.join(' ');
    expect(unchecked).toContain('DKIM');
    expect(unchecked).toContain('Inbox placement');
    expect(unchecked).toContain('send.');
  });

  it('DMARC report mailboxes are redacted from everything build() returns', () => {
    const rec = makeRec('acme.dev', {
      dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none; rua=mailto:jane.doe@acme.dev,mailto:x@y.io; ruf=mailto:z@acme.dev',
      rua: ['mailto:jane.doe@acme.dev'], spf: 'ok', spfRaw: 'v=spf1 ~all', dmarcPolicy: 'none',
    });
    const text = JSON.stringify(build(rec, CHECKED));
    expect(text).not.toContain('jane.doe');
    expect(text).not.toContain('x@y.io');
    expect(text).not.toContain('z@acme.dev');
    expect(text).toContain('mailto:<address>');
  });
});

describe('BIMI findings (test_bimi.py)', () => {
  const enforced = (o: RecOptions = {}) => {
    const policy = o.dmarcPolicy ?? 'reject';
    return makeRec('brand.com', {
      providers: [GOOGLE], spf: 'ok', spfRaw: SPF, dmarc: 'found', dmarcRaw: `v=DMARC1; p=${policy}; rua=mailto:r@brand.com`, rua: ['mailto:r@brand.com'], ...o, dmarcPolicy: policy,
    });
  };
  const bimiIds = (r: DomainReport) => Object.keys(ids(r)).filter(i => i.startsWith('bimi'));

  it('no BIMI record is a low fact', () => {
    const got = ids(enforced());
    expect(got['bimi-missing'].severity).toBe('low');
    expect(got['bimi-missing'].confidence).toBeGreaterThanOrEqual(0.9);
    expect(got['bimi-missing'].evidence[0]).toContain('default._bimi.brand.com');
    expect(got['bimi-blocked-by-dmarc-none']).toBeUndefined();
  });

  it('DMARC p=none and a missing DMARC record block BIMI', () => {
    const none = ids(makeRec('brand.com', { providers: [GOOGLE], spf: 'ok', spfRaw: SPF, dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none; rua=mailto:r@brand.com', rua: ['mailto:r@brand.com'] }));
    expect(none['bimi-blocked-by-dmarc-none'].evidence[0]).toContain('p=none');
    expect(ids(makeRec('brand.com', { providers: [GOOGLE] }))['bimi-blocked-by-dmarc-none']).toBeDefined();
  });

  it('a partial pct blocks BIMI but is not called p=none', () => {
    const got = ids(enforced({ dmarcPolicy: 'quarantine', pct: 50 }));
    expect(got['bimi-blocked-by-dmarc-pct']).toBeDefined();
    expect(got['bimi-blocked-by-dmarc-none']).toBeUndefined();
    expect(ids(enforced({ dmarcPolicy: 'quarantine', pct: 100 }))['bimi-blocked-by-dmarc-pct']).toBeUndefined();
  });

  it('a BIMI record without a certificate', () => {
    const got = ids(enforced({ bimi: bimiRec({ vmc: 'not-declared' }) }));
    expect(got['bimi-no-certificate'].evidence[1]).toContain('no a= certificate URL');
    expect(got['bimi-missing']).toBeUndefined();
    expect(got['bimi-logo-invalid']).toBeUndefined();
  });

  it('a logo that is missing or not an SVG', () => {
    expect(ids(enforced({ bimi: bimiRec({ logo: 'invalid' }) }))['bimi-logo-invalid']).toBeDefined();
    expect(ids(enforced({ bimi: bimiRec({ logo: 'missing' }) }))['bimi-logo-invalid']).toBeDefined();
  });

  it('a complete setup and unreachable assets raise no BIMI finding', () => {
    expect(bimiIds(enforced({ bimi: bimiRec() }))).toEqual([]);
    const rec = enforced({ bimi: bimiRec({ logo: 'unreachable', vmc: 'unreachable' }) });
    expect(bimiIds(rec)).toEqual([]); // a fetch failure is "unchecked", never a finding
    expect(build(rec, CHECKED).unchecked.some(u => u.includes('BIMI logo'))).toBe(true);
  });

  it('a declined BIMI record is respected', () => {
    const declined = { status: 'declined' as const, raw: 'v=BIMI1; l=; a=', foundAt: 'default._bimi.brand.com', logo: { url: null, status: 'not-declared' as const }, vmc: { url: null, status: 'not-declared' as const, validated: false as const } };
    expect(ids(enforced({ bimi: declined }))['bimi-missing']).toBeUndefined();
  });

  it('a non-mail domain gets no BIMI findings (mail-domain gating)', () => {
    expect(bimiIds(makeRec('brand.com', { mx: ['none', []] }))).toEqual([]);
  });

  it('sp=none blocks BIMI even when p=reject', () => {
    const sp = (value: 'none' | 'reject') => {
      const r = enforced({ dmarcRaw: `v=DMARC1; p=reject; sp=${value}; rua=mailto:r@brand.com` });
      r.dmarc.record!.subdomainPolicy = value;
      return r;
    };
    const got = ids(sp('none'));
    expect(got['bimi-blocked-by-dmarc-none'].evidence[0]).toContain('sp=none');
    expect(ids(sp('reject'))['bimi-blocked-by-dmarc-none']).toBeUndefined();
  });

  it('a malformed pct does not crash and counts as 100', () => {
    for (const bad of ['abc', '', '5%', null]) {
      expect(ids(enforced({ dmarcPolicy: 'quarantine', pct: bad }))['bimi-blocked-by-dmarc-pct']).toBeUndefined();
    }
    expect(pctOf('abc')).toBe(100);
    expect(pctOf('50')).toBe(50);
  });

  it('recommendations do not overclaim Apple', () => {
    const f = findingsOf(enforced({ bimi: bimiRec({ vmc: 'not-declared' }) }), CHECKED).find(x => x.id === 'bimi-no-certificate')!;
    expect(f.recommendation).not.toMatch(/Gmail and Apple Mail (will not|need)|can show in Gmail and Apple Mail/);
  });
});
