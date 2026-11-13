import { describe, expect, it } from 'vitest';
import { normalizeDomainInput } from '../src/lib/domain-input';

describe('normalizeDomainInput', () => {
	it.each([
		['example.com', 'example.com'],
		['mail.example.co.uk', 'mail.example.co.uk'],
		['a-b.example.com', 'a-b.example.com'],
		['  example.com  ', 'example.com'],
		['EXAMPLE.Com', 'example.com'],
		['example.com.', 'example.com'],
		['münchen.de', 'xn--mnchen-3ya.de'],
		['München.DE', 'xn--mnchen-3ya.de'],
		['a'.repeat(63) + '.com', 'a'.repeat(63) + '.com'],
	])('accepts %j as %j', (input, out) => {
		expect(normalizeDomainInput(input)).toBe(out);
	});

	it.each([
		['empty', ''],
		['spaces only', '   '],
		['inner space', 'exa mple.com'],
		['tab', 'example\t.com'],
		['newline', 'example.com\nevil.com'],
		['two trailing dots', 'example.com..'],
		['URL', 'https://x.com'],
		['path', 'x.com/path'],
		['query', 'x.com?a=1'],
		['fragment', 'x.com#a'],
		['userinfo', 'user@x.com'],
		['port', 'x.com:443'],
		['javascript scheme', 'javascript:alert(1)'],
		['markup', '<script>'],
		['image markup', '<img src=x onerror=alert(1)>'],
		['empty label', 'a..b.com'],
		['leading dot', '.example.com'],
		['leading hyphen', '-a.com'],
		['trailing hyphen', 'a-.com'],
		['64-char label', 'a'.repeat(64) + '.com'],
		['IPv4', '1.2.3.4'],
		['IPv4 in hex', '0x7f.0.0.1'],
		['single label', 'localhost'],
		['encoded dot', '%2e'],
		['encoded host', 'example%2ecom'],
		['backslash', 'x.com\\evil.com'],
		['control character', 'example\u0000.com'],
		['numeric TLD', 'example.123'],
		['one-letter TLD', 'example.c'],
		['underscore', 'a_b.example.com'],
	])('rejects %s', (_name, input) => {
		expect(normalizeDomainInput(input)).toBeNull();
	});

	it('rejects very long input', () => {
		expect(normalizeDomainInput('a.'.repeat(200) + 'com')).toBeNull();
		expect(normalizeDomainInput('x'.repeat(100_000))).toBeNull();
		const max = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
		expect(max.length).toBe(253);
		expect(normalizeDomainInput(max)).toBe(max);
		expect(normalizeDomainInput('e' + max)).toBeNull();
	});

	it('never lets a non-string through', () => {
		expect(normalizeDomainInput(undefined as unknown as string)).toBeNull();
		expect(normalizeDomainInput(null as unknown as string)).toBeNull();
	});
});
