import { describe, it, expect } from 'vitest';
import { lookupDmarc, parseDmarcRecord, type DmarcLookup, type TxtResult } from '@inbox-angel/dns-checks';
import { dmarcFactsFor, dmarcFactsFromLookup, spfFromTxt } from '../../src/email/dns-snapshot';

const found = (raw: string, inherited: boolean): DmarcLookup => ({
  status: 'found', domain: 'mail.acme.com', record: parseDmarcRecord(raw), foundAt: inherited ? '_dmarc.acme.com' : '_dmarc.mail.acme.com', inherited, organizationalDomain: 'acme.com',
});

describe('dmarcFactsFromLookup: the effective policy for this domain', () => {
  it('keeps pct= and sp= of the record that applies, so partial enforcement is visible', () => {
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=reject; pct=10', false))).toEqual({ policy: 'reject', issue: null, inherited_from: null, pct: 10, sp: 'reject' });
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=reject; sp=none', false))).toEqual({ policy: 'reject', issue: null, inherited_from: null, pct: 100, sp: 'none' });
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=reject; sp=quarantine', true))).toEqual({ policy: 'quarantine', issue: null, inherited_from: 'acme.com', pct: 100, sp: 'quarantine' });
    expect(dmarcFactsFromLookup({ status: 'none', domain: 'a.com', record: null, foundAt: null, inherited: false, organizationalDomain: 'a.com' })).toEqual({ policy: null, issue: null, inherited_from: null, pct: null, sp: null });
  });

  it.each([
    ['v=DMARC1; p=reject; rua=mailto:a@b.c', 'reject'],
    ['v=DMARC1;p=Quarantine', 'quarantine'],
    ['v=DMARC1; sp=reject; p=none', 'none'], // own record: sp= is for subdomains of this domain, not for it
    ['v=DMARC1; t=y; p=none', 'none'],
  ])('own record %s -> %s', (rec, policy) => expect(dmarcFactsFromLookup(found(rec, false))).toMatchObject({ policy, issue: null, inherited_from: null }));

  it('inherited: the parent\'s sp= when it has one', () => {
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=none; sp=reject', true))).toMatchObject({ policy: 'reject', issue: null, inherited_from: 'acme.com' });
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=reject; sp=none', true))).toMatchObject({ policy: 'none', issue: null, inherited_from: 'acme.com' });
  });
  it('inherited: the parent\'s p= when sp is absent', () => {
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=quarantine', true))).toMatchObject({ policy: 'quarantine', issue: null, inherited_from: 'acme.com' });
  });
  it('no record at the domain or its parent is null with no issue (evidence of absence)', () => {
    expect(dmarcFactsFromLookup({ status: 'none', domain: 'a.com', record: null, foundAt: null, inherited: false, organizationalDomain: 'a.com' })).toMatchObject({ policy: null, issue: null, inherited_from: null });
  });
  it('a record with no valid p= gives no policy (not "none")', () => {
    expect(dmarcFactsFromLookup(found('v=DMARC1; sp=reject; rua=mailto:a@b.c', false))).toMatchObject({ policy: null, issue: 'invalid', inherited_from: null });
    expect(dmarcFactsFromLookup(found('v=DMARC1; p=banana', true))).toMatchObject({ policy: null, issue: 'invalid', inherited_from: 'acme.com' });
  });
  it('several records give no policy', () => {
    const l: DmarcLookup = { ...found('v=DMARC1; p=none', false), status: 'multiple', record: null, rawRecords: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] };
    expect(dmarcFactsFromLookup(l)).toMatchObject({ policy: null, issue: 'multiple', inherited_from: null });
    expect(dmarcFactsFromLookup({ ...l, inherited: true })).toMatchObject({ policy: null, issue: 'multiple', inherited_from: 'acme.com' });
  });
  it('a DNS failure is unknown: undefined, never "no record"', () => {
    expect(dmarcFactsFromLookup({ status: 'error', domain: 'a.com', record: null, foundAt: null, inherited: false, organizationalDomain: 'a.com', error: 'DNS SERVFAIL' })).toBeUndefined();
  });
});

describe('dmarcFactsFor: reuses the caller\'s own-name answer and asks for the parent only when needed', () => {
  const answers = (table: Record<string, TxtResult>) => {
    const asked: string[] = [];
    return { asked, resolver: { fetch: (() => { throw new Error('no http'); }) as any, resolve: async () => { throw new Error('unused'); }, txt: async (n: string) => { asked.push(n); return table[n] ?? { status: 'nxdomain' as const, records: [] }; } } };
  };
  const ok = (...records: string[]): TxtResult => ({ status: 'ok', records });

  it('an own record needs no further lookup', async () => {
    const { resolver, asked } = answers({});
    expect(await dmarcFactsFor(resolver, 'mail.acme.com', ok('v=DMARC1; p=none'))).toMatchObject({ policy: 'none', issue: null, inherited_from: null });
    expect(asked).toEqual([]);
  });
  it('no own record: one lookup at the organizational domain, and its sp= applies', async () => {
    const { resolver, asked } = answers({ '_dmarc.acme.com': ok('v=DMARC1; p=none; sp=reject') });
    expect(await dmarcFactsFor(resolver, 'mail.acme.com', { status: 'nxdomain', records: [] })).toMatchObject({ policy: 'reject', issue: null, inherited_from: 'acme.com' });
    expect(asked).toEqual(['_dmarc.acme.com']);
  });
  it('a parent without DMARC: null', async () => {
    const { resolver } = answers({});
    expect(await dmarcFactsFor(resolver, 'mail.acme.com', { status: 'nodata', records: [] })).toMatchObject({ policy: null, issue: null, inherited_from: null });
  });
  it('the parent lookup failing: undefined (nothing to store)', async () => {
    const { resolver } = answers({ '_dmarc.acme.com': { status: 'error', records: [], error: 'DNS SERVFAIL' } });
    expect(await dmarcFactsFor(resolver, 'mail.acme.com', { status: 'nxdomain', records: [] })).toBeUndefined();
  });
  it('an apex domain has no parent to ask', async () => {
    const { resolver, asked } = answers({});
    expect(await dmarcFactsFor(resolver, 'acme.com', { status: 'nxdomain', records: [] })).toMatchObject({ policy: null, issue: null, inherited_from: null });
    expect(asked).toEqual([]);
  });
  it('agrees with the package lookupDmarc the domain page uses', async () => {
    const { resolver } = answers({ '_dmarc.acme.com': ok('v=DMARC1; p=quarantine; sp=none') });
    const l = await lookupDmarc(resolver, 'mail.acme.com');
    expect(await dmarcFactsFor(resolver, 'mail.acme.com', { status: 'nxdomain', records: [] })).toEqual(dmarcFactsFromLookup(l));
  });
});

describe('spfFromTxt', () => {
  it('picks the SPF record out of the TXT answer, null when there is none', () => {
    expect(spfFromTxt(['google-site-verification=x', 'v=spf1 include:a.test -all'])).toBe('v=spf1 include:a.test -all');
    expect(spfFromTxt(['google-site-verification=x'])).toBeNull();
  });
});

// The same RFC 7489 tag rules as web/src/lib/dmarc-record.ts (both use parseDmarcTags from @inbox-angel/dns-checks).
describe('stored effective policy from raw TXT: whitespace, case, invalid sp=', () => {
  const ok = (...records: string[]): TxtResult => ({ status: 'ok', records });
  const resolverWith = (parent: TxtResult) => ({ fetch: (() => { throw new Error('no http'); }) as any, resolve: async () => { throw new Error('unused'); }, txt: async () => parent });
  const own = (rec: string) => dmarcFactsFor(resolverWith(ok()), 'mail.acme.com', ok(rec));
  const inherited = (rec: string) => dmarcFactsFor(resolverWith(ok(rec)), 'mail.acme.com', { status: 'nxdomain', records: [] });

  it.each([
    ['v=DMARC1; p = reject'],
    ['v=DMARC1 ; p\t=\treject ;'],
    ['v = DMARC1; p=reject'],
    ['V=DMARC1; P=Reject'],
  ])('own %j -> reject', async (rec) => expect(await own(rec)).toMatchObject({ policy: 'reject', issue: null, inherited_from: null }));

  it('inherited with sp=bogus: sp is absent, the parent\'s p applies', async () => {
    expect(await inherited('v=DMARC1; p=reject; sp=bogus')).toMatchObject({ policy: 'reject', issue: null, inherited_from: 'acme.com' });
  });
  it('inherited with sp = none: none', async () => {
    expect(await inherited('v=DMARC1; p=reject; sp = none')).toMatchObject({ policy: 'none', issue: null, inherited_from: 'acme.com' });
    expect(await inherited('v=DMARC1; p=reject; SP=None')).toMatchObject({ policy: 'none', issue: null, inherited_from: 'acme.com' });
  });
  it('own record with an invalid p: issue invalid, no policy', async () => {
    expect(await own('v=DMARC1; p=bogus')).toMatchObject({ policy: null, issue: 'invalid', inherited_from: null });
    expect(await own('v=DMARC1; p = ; rua=mailto:a@b.c')).toMatchObject({ policy: null, issue: 'invalid', inherited_from: null });
  });
});
