import { describe, it, expect } from 'vitest';
import { gradeDmarcPolicy, isDmarcRecord, lookupDmarc, parseDmarcRecord } from '../src/dmarc';
import { fakeResolver } from './helpers';

describe('parseDmarcRecord', () => {
  it('parses all tags', () => {
    const r = parseDmarcRecord('v=DMARC1; p=reject; sp=quarantine; pct=50; rua=mailto:a@x.com, mailto:b@x.com; ruf=mailto:f@x.com; adkim=s; aspf=r');
    expect(r).toMatchObject({ policy: 'reject', subdomainPolicy: 'quarantine', pct: 50, adkim: 's', aspf: 'r', valid: true });
    expect(r.rua).toEqual(['mailto:a@x.com', 'mailto:b@x.com']);
    expect(r.ruf).toEqual(['mailto:f@x.com']);
  });
  it('sp defaults to p, pct to 100', () => {
    const r = parseDmarcRecord('v=DMARC1; p=quarantine');
    expect(r.subdomainPolicy).toBe('quarantine');
    expect(r.pct).toBe(100);
  });
  it('flags a missing or invalid p= instead of silently treating it as none', () => {
    expect(parseDmarcRecord('v=DMARC1; rua=mailto:a@x.com').valid).toBe(false);
    expect(parseDmarcRecord('v=DMARC1; p=bogus').valid).toBe(false);
    expect(parseDmarcRecord('v=DMARC1; p=bogus').issues[0]).toMatch(/Invalid p=/);
  });
  it('flags an out-of-range pct but stays valid', () => {
    const r = parseDmarcRecord('v=DMARC1; p=reject; pct=250');
    expect(r.valid).toBe(true);
    expect(r.pct).toBe(100);
    expect(r.issues[0]).toMatch(/pct/);
  });
  it('is case-insensitive for tag names and policy values', () => {
    expect(parseDmarcRecord('v=DMARC1; P=REJECT').policy).toBe('reject');
  });
  it('isDmarcRecord', () => {
    expect(isDmarcRecord('v=DMARC1; p=none')).toBe(true);
    expect(isDmarcRecord('v=DMARC1;p=none')).toBe(true);
    expect(isDmarcRecord(' v=DMARC1')).toBe(true);
    expect(isDmarcRecord('v=DMARC10; p=none')).toBe(false);
    expect(isDmarcRecord('p=none; v=DMARC1')).toBe(false);
  });
});

describe('lookupDmarc', () => {
  it('finds the record at _dmarc.<domain>', async () => {
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.com': ['v=DMARC1; p=reject'] }), 'example.com');
    expect(l).toMatchObject({ status: 'found', inherited: false, foundAt: '_dmarc.example.com' });
    expect(l.record?.policy).toBe('reject');
  });
  it('falls back to the organizational domain', async () => {
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.com': ['v=DMARC1; p=quarantine'] }), 'a.b.example.com');
    expect(l).toMatchObject({ status: 'found', inherited: true, foundAt: '_dmarc.example.com', organizationalDomain: 'example.com' });
  });
  it('uses the Public Suffix List: mail.example.co.uk → example.co.uk, never co.uk', async () => {
    const calls: string[] = [];
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.co.uk': ['v=DMARC1; p=reject'], 'TXT _dmarc.co.uk': ['v=DMARC1; p=none; rua=mailto:evil@evil.test'] }, calls), 'mail.example.co.uk');
    expect(l.record?.policy).toBe('reject');
    expect(l.foundAt).toBe('_dmarc.example.co.uk');
    expect(calls).not.toContain('TXT _dmarc.co.uk');
  });
  it('never queries a public suffix even when nothing is found', async () => {
    const calls: string[] = [];
    const l = await lookupDmarc(fakeResolver({}, calls), 'mail.example.com.au');
    expect(l.status).toBe('none');
    expect(calls).toEqual(['TXT _dmarc.mail.example.com.au', 'TXT _dmarc.example.com.au']);
  });
  it('does not query the org domain twice for an org domain', async () => {
    const calls: string[] = [];
    await lookupDmarc(fakeResolver({}, calls), 'example.co.uk');
    expect(calls).toEqual(['TXT _dmarc.example.co.uk']);
  });
  it('an authoritative NXDOMAIN/NODATA everywhere → none', async () => {
    expect((await lookupDmarc(fakeResolver({}), 'example.com')).status).toBe('none');
    expect((await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.com': 'NODATA' }), 'example.com')).status).toBe('none');
  });
  it.each(['SERVFAIL', 'TIMEOUT', 'HTTP500', 'GARBAGE'] as const)('%s on the first lookup → error, not none', async f => {
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.com': f }), 'example.com');
    expect(l.status).toBe('error');
    expect(l.record).toBeNull();
  });
  it('an error on the org-domain fallback → error (the subdomain miss is not a conclusion)', async () => {
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.com': 'SERVFAIL' }), 'mail.example.com');
    expect(l.status).toBe('error');
  });
  it('ignores non-DMARC TXT at _dmarc', async () => {
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.example.com': ['hello'] }), 'example.com');
    expect(l.status).toBe('none');
  });
  it('multiple DMARC records → multiple (DMARC does not apply), no fallback', async () => {
    const calls: string[] = [];
    const l = await lookupDmarc(fakeResolver({ 'TXT _dmarc.mail.example.com': ['v=DMARC1; p=none', 'v=DMARC1; p=reject'], 'TXT _dmarc.example.com': ['v=DMARC1; p=reject'] }, calls), 'mail.example.com');
    expect(l.status).toBe('multiple');
    expect(calls).toHaveLength(1);
  });
});

describe('gradeDmarcPolicy', () => {
  const g = (r: string) => gradeDmarcPolicy(parseDmarcRecord(r));
  it('grades', () => {
    expect(gradeDmarcPolicy(null)).toBe('missing');
    expect(g('v=DMARC1; rua=mailto:a@x.com')).toBe('missing');
    expect(g('v=DMARC1; p=none')).toBe('monitoring');
    expect(g('v=DMARC1; p=quarantine; pct=25')).toBe('partial');
    expect(g('v=DMARC1; p=quarantine')).toBe('enforced');
    expect(g('v=DMARC1; p=reject; pct=99')).toBe('partial');
    expect(g('v=DMARC1; p=reject')).toBe('strict');
  });
});
