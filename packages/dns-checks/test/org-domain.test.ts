import { describe, it, expect } from 'vitest';
import { organizationalDomain, isPublicSuffix } from '../src/org-domain';

describe('organizationalDomain (Public Suffix List)', () => {
  it.each([
    ['example.com', 'example.com'],
    ['mail.example.com', 'example.com'],
    ['a.b.c.example.com', 'example.com'],
    ['mail.example.co.uk', 'example.co.uk'],
    ['example.co.uk', 'example.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['www.example.co.jp', 'example.co.jp'],
    ['Mail.Example.CO.UK.', 'example.co.uk'],
    ['alice.github.io', 'alice.github.io'],
    ['www.alice.github.io', 'alice.github.io'],
  ])('%s → %s', (input, expected) => {
    expect(organizationalDomain(input)).toBe(expected);
  });

  it.each(['co.uk', 'com', 'com.au', 'github.io'])('never returns the bare public suffix %s', s => {
    expect(organizationalDomain(s)).toBeNull();
    expect(isPublicSuffix(s)).toBe(true);
  });

  it('returns null for IPs and empty input', () => {
    expect(organizationalDomain('192.0.2.1')).toBeNull();
    expect(organizationalDomain('')).toBeNull();
  });
});
