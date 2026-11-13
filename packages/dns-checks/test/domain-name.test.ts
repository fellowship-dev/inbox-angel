import { describe, expect, it } from 'vitest';
import { INVALID_DOMAIN_MESSAGE, normalizeDomainName, specialUseMessage } from '../src/domain-name';

const ok = (domain: string) => ({ ok: true, domain });

describe('normalizeDomainName: accepted', () => {
  it.each([
    ['example.com', 'example.com'],
    ['example.org', 'example.org'],
    ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['a-b.co.uk', 'a-b.co.uk'],
    ['  EXAMPLE.Com.  ', 'example.com'],
    ['a'.repeat(63) + '.com', 'a'.repeat(63) + '.com'],
    ['localhost.example.com', 'localhost.example.com'],
    ['home.arpa.example.com', 'home.arpa.example.com'],
  ])('%j -> %j', (input, out) => {
    expect(normalizeDomainName(input)).toEqual(ok(out));
  });
});

describe('normalizeDomainName: invalid', () => {
  it.each([
    '', '   ', 'exa mple.com', 'example.com\nevil.com', 'https://x.com', 'x.com/path', 'x.com?a=1', 'x.com#a', 'user@x.com', 'x.com:443',
    'javascript:alert(1)', '<script>', 'a..b.com', '.example.com', '-a.com', 'a-.com', 'a'.repeat(64) + '.com', '1.2.3.4', '0x7f.0.0.1',
    'nodot', 'example%2ecom', 'x.com\\evil.com', 'example\u0000.com', 'example.123', 'example.c', 'a_b.example.com', 'example.com..',
  ])('%j is invalid', (input) => {
    expect(normalizeDomainName(input)).toEqual({ ok: false, reason: 'invalid' });
  });
  it('is invalid for a non-string', () => {
    expect(normalizeDomainName(undefined as never)).toEqual({ ok: false, reason: 'invalid' });
  });
  it('is invalid over 253 characters', () => {
    expect(normalizeDomainName(Array(5).fill('a'.repeat(60)).join('.') + '.com')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('normalizeDomainName: special-use names', () => {
  it.each([
    ['printer.local', 'printer.local'],
    ['nas.internal', 'nas.internal'],
    ['abc.onion', 'abc.onion'],
    ['site.test', 'site.test'],
    ['x.invalid', 'x.invalid'],
    ['printer.example', 'printer.example'],
    ['app.localhost', 'app.localhost'],
    ['localhost', 'localhost'],
    ['router.home.arpa', 'router.home.arpa'],
    ['1.0.0.127.in-addr.arpa', '1.0.0.127.in-addr.arpa'],
    ['x.alt', 'x.alt'],
    ['PRINTER.LOCAL.', 'printer.local'],
  ])('%j is special-use', (input, name) => {
    expect(normalizeDomainName(input)).toEqual({ ok: false, reason: 'special_use', name });
  });

  it('only the TLD is special: example.com and example.org stay allowed', () => {
    expect(normalizeDomainName('example.com')).toEqual(ok('example.com'));
    expect(normalizeDomainName('example.org')).toEqual(ok('example.org'));
    expect(normalizeDomainName('test.com')).toEqual(ok('test.com'));
    expect(normalizeDomainName('local.dev')).toEqual(ok('local.dev'));
  });

  it('has fixed messages', () => {
    expect(INVALID_DOMAIN_MESSAGE).toBe('invalid domain format');
    expect(specialUseMessage('printer.local')).toBe("printer.local is a special-use name and can't be monitored on the public internet.");
  });
});
