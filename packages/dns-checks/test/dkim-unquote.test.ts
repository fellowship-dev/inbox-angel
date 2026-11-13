import { describe, expect, it } from 'vitest';
import { parseDkimRecord } from '../src/dkim';
import { decodeTxtData } from '../src/txt';
import { decodeTxtData as fromDoh } from '../src/doh';

describe('decodeTxtData on TXT content', () => {
  it('strips the outer quotes', () => expect(decodeTxtData('"v=DKIM1; k=rsa; p="')).toBe('v=DKIM1; k=rsa; p='));
  it('joins split strings with nothing between them', () => expect(decodeTxtData('"v=DKIM1; k=rsa; " "p="')).toBe('v=DKIM1; k=rsa; p='));
  it('joins a long key split across strings', () => expect(decodeTxtData('"v=DKIM1; p=AAAA" "BBBB"')).toBe('v=DKIM1; p=AAAABBBB'));
  it('decodes \\DDD escapes', () => expect(decodeTxtData('"a\\059b"')).toBe('a;b'));
  it('returns unquoted content trimmed and CNAME targets untouched', () => {
    expect(decodeTxtData('  v=DKIM1; p=  ')).toBe('v=DKIM1; p=');
    expect(decodeTxtData('s1.domainkey.u1.wl.sendgrid.net')).toBe('s1.domainkey.u1.wl.sendgrid.net');
  });
  it('leaves a quoted tag value inside an unquoted record intact', () => {
    expect(decodeTxtData('v=DKIM1; n="note"; p=MIGfAB==')).toBe('v=DKIM1; n="note"; p=MIGfAB==');
  });
  it('is the same function the resolver uses', () => expect(fromDoh).toBe(decodeTxtData));
});

describe('parseDkimRecord reads resolver text as it is', () => {
  it('a record with a quoted note is neither revoked nor mangled', () => {
    const r = parseDkimRecord('v=DKIM1; n="note"; p=MIGfAB==');
    expect(r.revoked).toBe(false);
    expect(r.raw).toBe('v=DKIM1; n="note"; p=MIGfAB==');
  });
  it('an empty p= is revoked', () => expect(parseDkimRecord('v=DKIM1; k=rsa; p=').revoked).toBe(true));
  it('decoding once at the boundary revokes the quoted Cloudflare form', () => {
    expect(parseDkimRecord(decodeTxtData('"v=DKIM1; k=rsa; " "p="')).revoked).toBe(true);
  });
});
