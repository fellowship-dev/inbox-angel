import { describe, it, expect } from 'vitest';
import { dmarcPolicyFromTxt, spfFromTxt } from '../../src/email/dns-snapshot';

describe('dmarcPolicyFromTxt', () => {
  it.each([
    ['v=DMARC1; p=reject; rua=mailto:a@b.c', 'reject'],
    ['v=DMARC1;p=Quarantine', 'quarantine'],
    ['v=DMARC1; sp=reject; p=none', 'none'],
    ['v=DMARC1; t=y; p=none', 'none'],
  ])('%s -> %s', (rec, policy) => expect(dmarcPolicyFromTxt([rec])).toBe(policy));

  it('never reads sp= or t= as p=', () => {
    expect(dmarcPolicyFromTxt(['v=DMARC1; sp=reject; rua=mailto:a@b.c'])).toBeUndefined();
    expect(dmarcPolicyFromTxt(['v=DMARC1; rua=mailto:a@b.c; fp=reject'])).toBeUndefined();
  });
  it('no DMARC record at all is null (evidence of absence)', () => {
    expect(dmarcPolicyFromTxt([])).toBeNull();
    expect(dmarcPolicyFromTxt(['v=spf1 -all', 'google-site-verification=x'])).toBeNull();
  });
  it('several DMARC records or an invalid p= give no single policy: unknown, not stored', () => {
    expect(dmarcPolicyFromTxt(['v=DMARC1; p=none', 'v=DMARC1; p=reject'])).toBeUndefined();
    expect(dmarcPolicyFromTxt(['v=DMARC1; p=banana'])).toBeUndefined();
  });
});

describe('spfFromTxt', () => {
  it('picks the SPF record out of the TXT answer, null when there is none', () => {
    expect(spfFromTxt(['google-site-verification=x', 'v=spf1 include:a.test -all'])).toBe('v=spf1 include:a.test -all');
    expect(spfFromTxt(['google-site-verification=x'])).toBeNull();
  });
});
