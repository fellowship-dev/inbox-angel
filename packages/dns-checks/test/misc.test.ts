import { describe, it, expect } from 'vitest';
import { isDkimRecord, lookupDkim, parseDkimRecord, scanDkimSelectors, COMMON_DKIM_SELECTORS } from '../src/dkim';
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

describe('isDkimRecord', () => {
  const KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3QxK7lY1b5y0kXk4dQ7sN0v2wZkq8J7u0cV8mB0pQwJ3v1sXx8m4H+oYtq9uQ8Zp3b2hP6s5r1nJ0Wk7oQd4eF2yTg9cLxA8vR3kS0uN6pZ1mI5jH7bV9wE2tY4aG0fDqXz8cKuO5nM3sP1rL6iU7oQIDAQAB';
  it('rejects a DMARC record, however it is quoted or spaced', () => {
    expect(isDkimRecord('v=DMARC1; p=reject; rua=mailto:a@x.com')).toBe(false);
    expect(isDkimRecord('  "v=dmarc1; p=none"')).toBe(false);
  });
  it('rejects an SPF record', () => {
    expect(isDkimRecord('v=spf1 include:_spf.google.com p=all -all')).toBe(false);
    expect(isDkimRecord('V=SPF1 -all')).toBe(false);
  });
  it('accepts a real DKIM key, with or without v=', () => {
    expect(isDkimRecord(`v=DKIM1; k=rsa; p=${KEY}`)).toBe(true);
    expect(isDkimRecord(`v=DKIM1;p=${KEY}`)).toBe(true);
    expect(isDkimRecord(`k=rsa; p=${KEY}`)).toBe(true);
    expect(isDkimRecord(`"v=DKIM1; k=rsa; p=${KEY.slice(0, 40)} ${KEY.slice(40)}"`)).toBe(true);
    expect(isDkimRecord('v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=')).toBe(true);
  });
  it('accepts a revoked key (empty p=)', () => {
    expect(isDkimRecord('v=DKIM1; p=')).toBe(true);
    expect(isDkimRecord('p=')).toBe(true);
    expect(isDkimRecord('k=rsa; p=;')).toBe(true);
  });
  it('rejects v=DKIM1 without a p= tag, other versions, and records with no v= and no p=', () => {
    expect(isDkimRecord('v=DKIM1; k=rsa')).toBe(false);
    expect(isDkimRecord('v=BIMI1; p=abc')).toBe(false);
    expect(isDkimRecord('k=rsa')).toBe(false);
  });
  it('rejects garbage that merely contains p=', () => {
    expect(isDkimRecord('google-site-verification=p=abc')).toBe(false);
    expect(isDkimRecord('hello p=world!!')).toBe(false);
    expect(isDkimRecord('p=not base64 !!!')).toBe(false);
    expect(isDkimRecord('foo=bar; p=abc')).toBe(false);
    expect(isDkimRecord('')).toBe(false);
  });
});

describe('isDkimRecord ignores unknown tags (RFC 6376 §3.6.1)', () => {
  const KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3QxK7lY1b5y0kXk4dQ7sN0v2wZkq8J7u0cV8mB0pQwJ3v1sXx8m4H+oYtq9uQ8Zp3b2hP6s5r1nJ0Wk7oQIDAQAB';
  it.each([
    ['r=y', `v=DKIM1; k=rsa; p=${KEY}; r=y`],
    ['o=-', `v=DKIM1; p=${KEY}; o=-`],
    ['x=foo', `v=DKIM1; k=rsa; p=${KEY}; x=foo`],
    ['notes=…', `v=DKIM1; p=${KEY}; notes=signing key for the mailer, rotated 2026`],
    ['an escaped semicolon', `v=DKIM1; p=${KEY}; notes=a\\;b; k=rsa`],
    ['an unknown tag before p=', `v=DKIM1; r=y; p=${KEY}`],
  ])('accepts a key with %s', (_n, txt) => expect(isDkimRecord(txt)).toBe(true));
  it('accepts a revoked key, also with an unknown tag', () => {
    expect(isDkimRecord('v=DKIM1; p=')).toBe(true);
    expect(isDkimRecord('v=DKIM1; p=; r=y')).toBe(true);
    expect(isDkimRecord('v=DKIM1; p= ; notes=revoked')).toBe(true);
  });
  it('refuses a tag name that is not syntactically valid', () => {
    expect(isDkimRecord(`v=DKIM1; p=${KEY}; 9x=1`)).toBe(false);
    expect(isDkimRecord(`v=DKIM1; p=${KEY}; bad-name=1`)).toBe(false);
    expect(isDkimRecord(`v=DKIM1; p=${KEY}; =1`)).toBe(false);
    expect(isDkimRecord(`v=DKIM1; p=${KEY}; justtext`)).toBe(false);
  });
  it('still refuses DMARC and SPF records, whatever tags they carry', () => {
    expect(isDkimRecord('v=DMARC1; p=reject; rua=mailto:a@x.com; r=y')).toBe(false);
    expect(isDkimRecord('v=spf1 include:_spf.x.com -all')).toBe(false);
  });
  it('refuses a p= that is not base64, or a v= that is not first', () => {
    expect(isDkimRecord('v=DKIM1; p=not base64 !!!; r=y')).toBe(false);
    expect(isDkimRecord(`k=rsa; v=DKIM1; p=${KEY}`)).toBe(false);
  });
  it('keeps the strict shape for a record without v=: an unknown tag refuses it', () => {
    expect(isDkimRecord(`k=rsa; p=${KEY}; r=y`)).toBe(false);
    expect(isDkimRecord(`p=${KEY}; notes=x`)).toBe(false);
    expect(isDkimRecord(`k=rsa; p=${KEY}`)).toBe(true);
  });
});

describe('scanDkimSelectors on a wildcard', () => {
  const govUk = 'v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@x.gov.uk';
  const wildcardZone = (record: string) => Object.fromEntries(COMMON_DKIM_SELECTORS.map(s => [`TXT ${s}._domainkey.x.gov.uk`, [record]]));

  it('a name that answers every selector with the DMARC record gives no keys, and is reported as a wildcard', async () => {
    const scan = await scanDkimSelectors(fakeResolver(wildcardZone(govUk)), 'x.gov.uk');
    expect(scan.found).toEqual([]);
    expect(scan.wildcard).toBe(true);
    expect(scan.wildcardRecord).toBe(govUk);
    expect(scan.errors).toEqual([]);
  });

  it('a wildcard that answers with an identical DKIM key is still a wildcard, with no keys', async () => {
    const key = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
    const scan = await scanDkimSelectors(fakeResolver(wildcardZone(key)), 'x.gov.uk');
    expect(scan.wildcard).toBe(true);
    expect(scan.wildcardRecord).toBe(key);
    expect(scan.found).toEqual([]);
  });

  it('is not a wildcard with fewer than 3 answers, or when the answers differ', async () => {
    const two = await scanDkimSelectors(fakeResolver({ 'TXT google._domainkey.x.com': ['v=DKIM1; p=AAA'], 'TXT s1._domainkey.x.com': ['v=DKIM1; p=AAA'] }), 'x.com');
    expect(two.wildcard).toBe(false);
    expect(two.found.map(f => f.selector)).toEqual(['google', 's1']);
    const differ = await scanDkimSelectors(fakeResolver({ 'TXT google._domainkey.x.com': ['v=DKIM1; p=AAA'], 'TXT s1._domainkey.x.com': ['v=DKIM1; p=BBB'], 'TXT s2._domainkey.x.com': ['v=DKIM1; p=CCC'] }), 'x.com');
    expect(differ.wildcard).toBe(false);
    expect(differ.found).toHaveLength(3);
  });

  it('a shared DMARC record plus one real key is not a wildcard, and only the real key is found', async () => {
    const zone = { ...wildcardZone(govUk), 'TXT google._domainkey.x.gov.uk': ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'] };
    const scan = await scanDkimSelectors(fakeResolver(zone), 'x.gov.uk');
    expect(scan.wildcard).toBe(false);
    expect(scan.found.map(f => f.selector)).toEqual(['google']);
  });

  it('a failed lookup is an error, never an answer: it neither breaks nor fakes a wildcard', async () => {
    const zone: Record<string, any> = wildcardZone(govUk);
    zone['TXT k1._domainkey.x.gov.uk'] = 'TIMEOUT';
    const scan = await scanDkimSelectors(fakeResolver(zone), 'x.gov.uk');
    expect(scan.errors.map(e => e.selector)).toEqual(['k1']);
    expect(scan.wildcard).toBe(true);
    expect(scan.found).toEqual([]);
  });
});
