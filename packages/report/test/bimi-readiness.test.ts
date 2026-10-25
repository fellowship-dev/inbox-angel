// Port of the readiness half of unzip-inboxangel outreach-tools/tests/test_bimi.py.
import { describe, expect, it } from 'vitest';
import { bimiReadiness, factsOf } from '../src/index';
import { CHECKED, GOOGLE, bimiRec, makeRec, type RecOptions } from './helpers';

const SPF = 'v=spf1 include:_spf.google.com ~all';
const enforced = (o: RecOptions = {}) => {
  const policy = o.dmarcPolicy ?? 'reject';
  return makeRec('brand.com', { providers: [GOOGLE], spf: 'ok', spfRaw: SPF, dmarc: 'found', dmarcRaw: `v=DMARC1; p=${policy}; rua=mailto:r@brand.com`, rua: ['mailto:r@brand.com'], ...o, dmarcPolicy: policy });
};
const readiness = (o: RecOptions = {}) => bimiReadiness(factsOf(enforced(o), CHECKED));

describe('BIMI readiness ladder', () => {
  it('p=none blocks at step 1, every step todo', () => {
    const r = bimiReadiness(factsOf(makeRec('brand.com', { providers: [GOOGLE], dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none' }), CHECKED));
    expect(r.ready).toBe(false);
    expect(r.next).toBe('dmarc-enforced');
    expect(r.steps.map(s => s.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(r.steps[0].now).toBe('p=none');
  });

  it('enforced DMARC with no BIMI record names the record as next (logo before it is also todo)', () => {
    const r = readiness();
    expect(r.steps.map(s => [s.id, s.state])).toEqual([['dmarc-enforced', 'done'], ['dmarc-pct', 'done'], ['logo', 'todo'], ['record', 'todo'], ['certificate', 'todo']]);
    expect(r.steps.find(s => s.id === 'record')!.now).toBe('not published');
    expect(r.summary).toBe('2 of 5 steps done. Next: Logo as an SVG on HTTPS.');
  });

  it('ready, part-way and unknown', () => {
    const ready = readiness({ bimi: bimiRec() });
    expect(ready.ready).toBe(true);
    expect(ready.next).toBeNull();
    expect(ready.summary.startsWith('Prerequisites are present')).toBe(true);
    expect(ready.summary).toContain('not that they are valid');
    const partway = readiness({ bimi: bimiRec({ vmc: 'not-declared' }) });
    expect(partway.next).toBe('certificate');
    expect(partway.summary.startsWith('4 of 5')).toBe(true);
    const unknown = readiness({ bimi: bimiRec({ logo: 'unreachable' }) });
    expect(unknown.steps.find(s => s.id === 'logo')!.state).toBe('unknown');
  });

  it('sp=none keeps step 1 todo even with p=reject', () => {
    const sp = (value: 'none' | 'quarantine') => {
      const rec = enforced({ dmarcRaw: `v=DMARC1; p=reject; sp=${value}; rua=mailto:r@brand.com`, bimi: bimiRec() });
      rec.dmarc.record!.subdomainPolicy = value;
      return bimiReadiness(factsOf(rec, CHECKED));
    };
    const r = sp('none');
    expect(r.ready).toBe(false);
    expect(r.next).toBe('dmarc-enforced');
    expect(r.steps[0].now).toContain('sp=none');
    expect(sp('quarantine').ready).toBe(true);
  });

  it('a malformed pct counts as 100', () => {
    for (const bad of ['abc', '', '5%', null]) expect(readiness({ dmarcPolicy: 'quarantine', pct: bad }).steps[1].state).toBe('done');
    expect(readiness({ dmarcPolicy: 'quarantine', pct: 50 }).steps[1]).toMatchObject({ state: 'todo', now: 'pct=50' });
  });

  it('no step overclaims Apple', () => {
    const r = readiness({ bimi: bimiRec() });
    const blob = [r.summary, ...r.steps.map(s => s.why)].join(' ');
    expect(blob).not.toMatch(/Gmail and Apple Mail (will not|need)|can show in Gmail and Apple Mail/);
  });
});
