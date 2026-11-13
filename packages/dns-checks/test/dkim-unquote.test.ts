import { describe, expect, it } from 'vitest';
import { parseDkimRecord } from '../src/dkim';
import { unquoteTxt } from '../src/txt';

describe('unquoteTxt', () => {
  it('strips the outer quotes', () => expect(unquoteTxt('"v=DKIM1; k=rsa; p="')).toBe('v=DKIM1; k=rsa; p='));
  it('joins split strings with nothing between them', () => expect(unquoteTxt('"v=DKIM1; k=rsa; " "p="')).toBe('v=DKIM1; k=rsa; p='));
  it('joins a long key split across strings', () => expect(unquoteTxt('"v=DKIM1; p=AAAA" "BBBB"')).toBe('v=DKIM1; p=AAAABBBB'));
  it('returns unquoted content trimmed and CNAME targets untouched', () => {
    expect(unquoteTxt('  v=DKIM1; p=  ')).toBe('v=DKIM1; p=');
    expect(unquoteTxt('s1.domainkey.u1.wl.sendgrid.net')).toBe('s1.domainkey.u1.wl.sendgrid.net');
  });
});

describe('parseDkimRecord with quoted content', () => {
  it('quoted empty p= is revoked', () => expect(parseDkimRecord('"v=DKIM1; k=rsa; " "p="').revoked).toBe(true));
  it('quoted key is not revoked', () => expect(parseDkimRecord('"v=DKIM1; k=rsa; p=MIGf"').revoked).toBe(false));
});
