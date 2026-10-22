import { describe, it, expect } from 'vitest';
import { checkDomain } from '../src/report';
import { createResolver } from '../src/doh';
import { dohFetch, resp, type Zone } from './helpers';

const POLICY = 'version: STSv1\nmode: enforce\nmx: aspmx.l.google.com\nmax_age: 604800\n';
const run = (zone: Zone, http = {}) => checkDomain('x.com', { resolver: createResolver({ fetch: dohFetch(zone, [], http) }) });

const base: Zone = {
  'MX x.com': ['1 aspmx.l.google.com.'],
  'TXT x.com': ['v=spf1 include:_spf.google.com -all'],
  'TXT _spf.google.com': ['v=spf1 ip4:1.1.1.1 ~all'],
};

describe('checkDomain grading', () => {
  it('Level 0: nothing published (authoritative)', async () => {
    const r = await run({});
    expect(r.grade).toMatchObject({ level: 0, label: 'Unprotected', complete: true });
    expect(r.errors).toEqual([]);
  });
  it('Level 0: SPF but no DMARC', async () => {
    const r = await run(base);
    expect(r.grade.level).toBe(0);
    expect(r.grade.reasons).toContain('No DMARC record');
  });
  it('Level 1: SPF + DMARC p=none', async () => {
    const r = await run({ ...base, 'TXT _dmarc.x.com': ['v=DMARC1; p=none'] });
    expect(r.grade.level).toBe(1);
  });
  it('Level 1: quarantine at pct<100', async () => {
    expect((await run({ ...base, 'TXT _dmarc.x.com': ['v=DMARC1; p=quarantine; pct=50'] })).grade.level).toBe(1);
  });
  it('Level 2: quarantine at 100%', async () => {
    const r = await run({ ...base, 'TXT _dmarc.x.com': ['v=DMARC1; p=quarantine'] });
    expect(r.grade.level).toBe(2);
    expect(r.grade.nextSteps.length).toBeGreaterThan(0);
  });
  it('Level 2: reject but no DKIM/MTA-STS', async () => {
    expect((await run({ ...base, 'TXT _dmarc.x.com': ['v=DMARC1; p=reject'] })).grade.level).toBe(2);
  });
  it('Level 3: reject + SPF + DKIM + MTA-STS enforce', async () => {
    const r = await run({
      ...base,
      'TXT _dmarc.x.com': ['v=DMARC1; p=reject'],
      'TXT google._domainkey.x.com': ['v=DKIM1; k=rsa; p=AAA'],
      'TXT _mta-sts.x.com': ['v=STSv1; id=1'],
    }, { 'https://mta-sts.x.com/.well-known/mta-sts.txt': resp(200, POLICY, { 'content-type': 'text/plain' }) });
    expect(r.grade).toMatchObject({ level: 3, label: 'Hardened', complete: true });
    expect(r.providers.map(p => p.id)).toEqual(['google-workspace']);
  });
  it('level is inherited via the org-domain DMARC record', async () => {
    const r = await checkDomain('mail.x.com', { resolver: createResolver({ fetch: dohFetch({
      'TXT mail.x.com': ['v=spf1 -all'],
      'TXT _dmarc.x.com': ['v=DMARC1; p=reject'],
    }) }) });
    expect(r.dmarc.inherited).toBe(true);
    expect(r.grade.level).toBe(2);
  });
  it('a broken SPF (permerror) holds the grade at 0', async () => {
    const r = await run({ 'TXT x.com': ['v=spf1 -all', 'v=spf1 +all'], 'TXT _dmarc.x.com': ['v=DMARC1; p=reject'] });
    expect(r.grade.level).toBe(0);
    expect(r.spf.status).toBe('permerror');
  });
  it('+all does not earn Level 1', async () => {
    expect((await run({ 'TXT x.com': ['v=spf1 +all'], 'TXT _dmarc.x.com': ['v=DMARC1; p=reject'] })).grade.level).toBe(0);
  });
});

describe('checkDomain – DNS errors are never reported as "no record"', () => {
  it('DMARC SERVFAIL → inconclusive, not "Unprotected"', async () => {
    const r = await run({ ...base, 'TXT _dmarc.x.com': 'SERVFAIL' });
    expect(r.dmarc.status).toBe('error');
    expect(r.grade.level).toBeNull();
    expect(r.grade.label).toBe('Inconclusive');
    expect(r.grade.reasons.join(' ')).not.toMatch(/No DMARC record/);
    expect(r.errors.map(e => e.check)).toContain('dmarc');
  });
  it('SPF timeout → inconclusive', async () => {
    const r = await run({ 'TXT x.com': 'TIMEOUT', 'TXT _dmarc.x.com': ['v=DMARC1; p=reject'] });
    expect(r.spf.status).toBe('temperror');
    expect(r.grade.level).toBeNull();
  });
  it('a DKIM selector error does not read as "no DKIM"; level 3 is withheld and the grade is incomplete', async () => {
    const r = await run({
      ...base,
      'TXT _dmarc.x.com': ['v=DMARC1; p=reject'],
      'TXT selector1._domainkey.x.com': 'SERVFAIL',
      'TXT _mta-sts.x.com': ['v=STSv1; id=1'],
    }, { 'https://mta-sts.x.com/.well-known/mta-sts.txt': resp(200, POLICY) });
    expect(r.grade.level).toBe(2);
    expect(r.grade.complete).toBe(false);
    expect(r.grade.reasons.join(' ')).toMatch(/some lookups failed/);
  });
  it('does not throw when everything fails', async () => {
    const fetch = async () => { throw new Error('offline'); };
    const r = await checkDomain('x.com', { resolver: createResolver({ fetch: fetch as never }) });
    expect(r.grade.level).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it('options.fetch builds a resolver', async () => {
    const r = await checkDomain('x.com', { fetch: dohFetch({}), dkimSelectors: ['google'] });
    expect(r.dkim.scanned).toBe(1);
    expect(r.grade.level).toBe(0);
  });
});
