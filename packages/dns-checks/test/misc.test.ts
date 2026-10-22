import { describe, it, expect } from 'vitest';
import { lookupDkim, parseDkimRecord, scanDkimSelectors, COMMON_DKIM_SELECTORS } from '../src/dkim';
import { lookupMx, parseMxData } from '../src/mx';
import { detectProviders } from '../src/providers';
import { fakeResolver } from './helpers';

describe('dkim', () => {
  it('parses tags and detects revoked keys', () => {
    expect(parseDkimRecord('v=DKIM1; k=rsa; p=ABC')).toMatchObject({ version: 'DKIM1', keyType: 'rsa', revoked: false });
    expect(parseDkimRecord('v=DKIM1; k=ed25519; p=ABC').keyType).toBe('ed25519');
    expect(parseDkimRecord('v=DKIM1; p=').revoked).toBe(true);
    expect(parseDkimRecord('v=DKIM1; p=AA BB\n CC').revoked).toBe(false);
  });
  it('found / none / error are distinct', async () => {
    const r = fakeResolver({ 'TXT s1._domainkey.x.com': ['v=DKIM1; k=rsa; p=ABC'], 'TXT s2._domainkey.x.com': ['unrelated'], 'TXT s3._domainkey.x.com': 'SERVFAIL' });
    expect((await lookupDkim(r, 'x.com', 's1')).status).toBe('found');
    expect((await lookupDkim(r, 'x.com', 's2')).status).toBe('none');
    expect((await lookupDkim(r, 'x.com', 'nope')).status).toBe('none');
    expect((await lookupDkim(r, 'x.com', 's3')).status).toBe('error');
  });
  it('accepts a record with only p= or k= (no v=)', async () => {
    expect((await lookupDkim(fakeResolver({ 'TXT a._domainkey.x.com': ['k=rsa; p=MIIB'] }), 'x.com', 'a')).status).toBe('found');
  });
  it('scan covers the common selectors and separates errors from misses', async () => {
    for (const s of ['google', 'selector1', 'selector2', 'resend', 'k1', 's1', 's2', 'mandrill', 'amazonses', 'default']) {
      expect(COMMON_DKIM_SELECTORS).toContain(s);
    }
    const scan = await scanDkimSelectors(fakeResolver({ 'TXT google._domainkey.x.com': ['v=DKIM1; p=AAA'], 'TXT k1._domainkey.x.com': 'TIMEOUT' }), 'x.com');
    expect(scan.found.map(f => f.selector)).toEqual(['google']);
    expect(scan.errors.map(f => f.selector)).toEqual(['k1']);
    expect(scan.scanned).toBe(COMMON_DKIM_SELECTORS.length);
  });
});

describe('mx', () => {
  it('parses MX data', () => {
    expect(parseMxData('10 Mail.Example.com.')).toEqual({ priority: 10, host: 'mail.example.com' });
    expect(parseMxData('garbage')).toBeNull();
  });
  it('sorts by priority', async () => {
    const l = await lookupMx(fakeResolver({ 'MX x.com': ['20 b.x.com.', '10 a.x.com.'] }), 'x.com');
    expect(l.hosts.map(h => h.host)).toEqual(['a.x.com', 'b.x.com']);
  });
  it('none vs error vs null-mx', async () => {
    expect((await lookupMx(fakeResolver({}), 'x.com')).status).toBe('none');
    expect((await lookupMx(fakeResolver({ 'MX x.com': 'NODATA' }), 'x.com')).status).toBe('none');
    expect((await lookupMx(fakeResolver({ 'MX x.com': 'SERVFAIL' }), 'x.com')).status).toBe('error');
    expect((await lookupMx(fakeResolver({ 'MX x.com': ['0 .'] }), 'x.com')).status).toBe('null-mx');
  });
  it('a malformed MX answer is an error', async () => {
    expect((await lookupMx(fakeResolver({ 'MX x.com': ['nonsense'] }), 'x.com')).status).toBe('error');
  });
});

describe('providers', () => {
  const ids = (s: Parameters<typeof detectProviders>[0]) => detectProviders(s).map(p => p.id);
  it('detects mailbox providers from MX', () => {
    expect(ids({ mxHosts: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'] })).toEqual(['google-workspace']);
    expect(ids({ mxHosts: ['example-com.mail.protection.outlook.com'] })).toEqual(['microsoft-365']);
    expect(ids({ mxHosts: ['mx.zoho.com', 'mx2.zoho.eu'] })).toEqual(['zoho']);
  });
  it('detects senders from SPF includes', () => {
    const got = ids({ spfIncludes: ['_spf.google.com', 'amazonses.com', 'sendgrid.net', 'mailgun.org', 'spf.mtasv.net', 'send.resend.com', 'shops.shopify.com', 'spf.protection.outlook.com'] });
    expect(got).toEqual(expect.arrayContaining(['google-workspace', 'amazon-ses', 'sendgrid', 'mailgun', 'postmark', 'resend', 'shopify', 'microsoft-365']));
  });
  it('records evidence and ignores unknown hosts and look-alikes', () => {
    const p = detectProviders({ mxHosts: ['mail.example.com', 'aspmx.l.google.com.evil.test'], spfIncludes: ['notamazonses.com'] });
    expect(p).toEqual([]);
    expect(detectProviders({ mxHosts: ['ASPMX.L.GOOGLE.COM.'] })[0].evidence).toEqual(['mx:aspmx.l.google.com']);
  });
});
