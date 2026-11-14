import { describe, it, expect } from 'vitest';
import { lookupDmarc, parseDmarcRecord } from '../src/dmarc';
import { ownRecordFromInherited, planReportAddress, recordHasAddress, ruaEntries, ruaEntryAddress, withReportAddress } from '../src/dmarc-rua';
import { fakeResolver } from './helpers';

const OURS = 'rua+abcdefghijklmnopqrstuvwxyz234567@rua.example.net';
const plan = async (zone: Parameters<typeof fakeResolver>[0], domain: string) => planReportAddress(await lookupDmarc(fakeResolver(zone), domain), OURS);

describe('rua entries', () => {
  it('reads the list as published and compares addresses without mailto:, size limit or letter case', () => {
    expect(ruaEntries('v=DMARC1; p=reject; rua=mailto:a@x.com, mailto:b@y.com!10m')).toEqual(['mailto:a@x.com', 'mailto:b@y.com!10m']);
    expect(ruaEntries('v=DMARC1; p=reject')).toEqual([]);
    expect(ruaEntries('v=DMARC1; p=reject; rua=')).toEqual([]);
    expect(ruaEntryAddress(' MAILTO:B@Y.com!10m ')).toBe('b@y.com');
    expect(recordHasAddress(`v=DMARC1; p=none; RUA=mailto:${OURS.toUpperCase()}!25m`, OURS)).toBe(true);
    // A substring is not a match: a longer address that contains ours is someone else's.
    expect(recordHasAddress(`v=DMARC1; p=none; rua=mailto:x${OURS}`, OURS)).toBe(false);
  });
});

describe('withReportAddress', () => {
  it('appends to an existing rua= in place and leaves every other tag, its order and spacing alone', () => {
    const rec = 'v=DMARC1;p=reject; sp=quarantine;  pct=50; rua=mailto:a@x.com; fo=1; adkim=s;';
    expect(withReportAddress(rec, OURS)).toBe(`v=DMARC1;p=reject; sp=quarantine;  pct=50; rua=mailto:a@x.com,mailto:${OURS}; fo=1; adkim=s`);
  });
  it('adds rua= at the end when there is none', () => {
    expect(withReportAddress('v=DMARC1; p=quarantine; pct=25', OURS)).toBe(`v=DMARC1; p=quarantine; pct=25; rua=mailto:${OURS}`);
  });
  it('replaces exactly the entry chosen, keeping the other one and its position', () => {
    const rec = 'v=DMARC1; p=reject; rua=mailto:a@x.com,mailto:b@y.com!10m';
    expect(withReportAddress(rec, OURS, 'mailto:a@x.com')).toBe(`v=DMARC1; p=reject; rua=mailto:${OURS},mailto:b@y.com!10m`);
    expect(withReportAddress(rec, OURS, 'mailto:b@y.com!10m')).toBe(`v=DMARC1; p=reject; rua=mailto:a@x.com,mailto:${OURS}`);
    // a stale choice (the record changed meanwhile) never drops ours or anything else
    expect(withReportAddress(rec, OURS, 'mailto:gone@z.com')).toBe(`v=DMARC1; p=reject; rua=mailto:a@x.com,mailto:b@y.com!10m,mailto:${OURS}`);
  });
  it('never changes the policy: p=, sp= and pct= are identical before and after', () => {
    for (const rec of ['v=DMARC1; p=reject', 'v=DMARC1; p=quarantine; pct=10; sp=reject', 'v=DMARC1; p=none; sp=none; rua=mailto:a@x.com']) {
      const before = parseDmarcRecord(rec);
      const after = parseDmarcRecord(withReportAddress(rec, OURS));
      expect([after.policy, after.subdomainPolicy, after.pct, after.adkim, after.aspf]).toEqual([before.policy, before.subdomainPolicy, before.pct, before.adkim, before.aspf]);
      expect(after.rua.at(-1)).toBe(`mailto:${OURS}`);
    }
  });
});

describe('ownRecordFromInherited', () => {
  it('carries exactly the enforcement in force: p= (sp= when present), pct= when enforcing below 100, adkim=/aspf=', () => {
    expect(ownRecordFromInherited('v=DMARC1; p=reject; sp=quarantine; pct=50; adkim=s; rua=mailto:a@x.com; fo=1', 'quarantine', OURS))
      .toBe(`v=DMARC1; p=quarantine; pct=50; adkim=s; rua=mailto:${OURS}`);
    expect(ownRecordFromInherited('v=DMARC1; p=none; pct=10; aspf=s', 'none')).toBe('v=DMARC1; p=none; aspf=s'); // pct means nothing at p=none
    expect(ownRecordFromInherited('v=DMARC1; p=reject; adkim=r', 'reject')).toBe('v=DMARC1; p=reject; adkim=r');
  });
});

describe('planReportAddress', () => {
  it('google.com-like: one rua address already → add ours as the second, policy untouched', async () => {
    const p = await plan({ 'TXT _dmarc.google.com': ['v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com'] }, 'google.com');
    expect(p).toEqual({ kind: 'add', name: '_dmarc.google.com', current: 'v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com', record: `v=DMARC1; p=reject; rua=mailto:mailauth-reports@google.com,mailto:${OURS}`, created: false });
  });

  it('two addresses already → a choice: replace either one, or add a third knowingly; nothing is dropped silently', async () => {
    const rec = 'v=DMARC1; p=quarantine; rua=mailto:a@x.com,mailto:b@y.com';
    const p = await plan({ 'TXT _dmarc.two.test': [rec] }, 'two.test');
    expect(p?.kind).toBe('choose');
    if (p?.kind !== 'choose') return;
    expect(p.existing).toEqual(['mailto:a@x.com', 'mailto:b@y.com']);
    expect(p.options).toEqual([
      { replaces: 'mailto:a@x.com', record: `v=DMARC1; p=quarantine; rua=mailto:${OURS},mailto:b@y.com` },
      { replaces: 'mailto:b@y.com', record: `v=DMARC1; p=quarantine; rua=mailto:a@x.com,mailto:${OURS}` },
      { replaces: null, record: `v=DMARC1; p=quarantine; rua=mailto:a@x.com,mailto:b@y.com,mailto:${OURS}` },
    ]);
    for (const o of p.options) expect(parseDmarcRecord(o.record).policy).toBe('quarantine');
  });

  it('no DMARC record at all → p=none with our address (monitoring only)', async () => {
    expect(await plan({ 'TXT _dmarc.fresh.test': 'NODATA' }, 'fresh.test')).toEqual({ kind: 'add', name: '_dmarc.fresh.test', current: null, record: `v=DMARC1; p=none; rua=mailto:${OURS}`, created: true });
    expect(await plan({}, 'fresh.test')).toMatchObject({ kind: 'add', current: null, created: true }); // NXDOMAIN is "no record" too
  });

  it('already listed → published', async () => {
    expect(await plan({ 'TXT _dmarc.done.test': [`v=DMARC1; p=reject; rua=mailto:a@x.com,mailto:${OURS}`] }, 'done.test')).toMatchObject({ kind: 'published', name: '_dmarc.done.test' });
  });

  it('a failed lookup is unknown (null), never "no record"', async () => {
    expect(await plan({ 'TXT _dmarc.flaky.test': 'SERVFAIL' }, 'flaky.test')).toBeNull();
    expect(await plan({ 'TXT _dmarc.sub.flaky.test': 'NODATA', 'TXT _dmarc.flaky.test': 'TIMEOUT' }, 'sub.flaky.test')).toBeNull();
  });

  it('several DMARC records → multiple, with the records and no proposal', async () => {
    const p = await plan({ 'TXT _dmarc.dup.test': ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }, 'dup.test');
    expect(p).toEqual({ kind: 'multiple', name: '_dmarc.dup.test', records: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] });
  });

  it('a subdomain that inherits: names the organizational domain and offers a record of its own with the effective policy (sp=)', async () => {
    const parent = 'v=DMARC1; p=reject; sp=quarantine; rua=mailto:a@iana.test';
    const p = await plan({ 'TXT _dmarc.mail.iana.test': 'NODATA', 'TXT _dmarc.iana.test': [parent] }, 'mail.iana.test');
    expect(p).toEqual({
      kind: 'inherited', from: 'iana.test', parent_record: parent, policy: 'quarantine', policy_tag: 'sp', parent_has_address: false,
      own: { kind: 'add', name: '_dmarc.mail.iana.test', current: null, record: `v=DMARC1; p=quarantine; rua=mailto:${OURS}`, created: true },
    });
  });

  it('a subdomain whose parent lists two addresses → its own record lists only ours (nothing to choose)', async () => {
    const p = await plan({ 'TXT _dmarc.iana.test': ['v=DMARC1; p=reject; rua=mailto:a@x.com,mailto:b@y.com'] }, 'sub.iana.test');
    expect(p?.kind).toBe('inherited');
    if (p?.kind !== 'inherited') return;
    expect(p.policy).toBe('reject');
    expect(p.own).toMatchObject({ kind: 'add', record: `v=DMARC1; p=reject; rua=mailto:${OURS}` });
  });

  it('an invalid record (no p=, or p= not a policy) is reported as invalid, with nothing proposed', async () => {
    expect(await plan({ 'TXT _dmarc.bad.test': ['v=DMARC1; p=bogus; rua=mailto:a@x.com'] }, 'bad.test')).toMatchObject({ kind: 'invalid', name: '_dmarc.bad.test', record: 'v=DMARC1; p=bogus; rua=mailto:a@x.com', issues: [expect.stringMatching(/Invalid p=/)] });
    expect(await plan({ 'TXT _dmarc.nop.test': ['v=DMARC1; rua=mailto:a@x.com'] }, 'nop.test')).toMatchObject({ kind: 'invalid', issues: [expect.stringMatching(/Missing required p=/)] });
    expect(await plan({ 'TXT _dmarc.bad.test': ['v=DMARC1; sp=reject'] }, 'mail.bad.test')).toMatchObject({ kind: 'invalid', name: '_dmarc.bad.test' }); // inherited from an invalid parent
  });

  it('an inherited policy names its tag: p= when the parent sets no valid sp=', async () => {
    const p = await plan({ 'TXT _dmarc.iana.test': ['v=DMARC1; p=reject'] }, 'mail.iana.test');
    expect(p).toMatchObject({ kind: 'inherited', policy: 'reject', policy_tag: 'p' });
  });
});
