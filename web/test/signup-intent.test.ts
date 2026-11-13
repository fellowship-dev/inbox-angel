import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_WORKSPACE_KEY, parseHash } from '../src/lib/workspace';
import { captureSignupIntent, clearSignupDomain, clearSignupDomainIf, readSignupDomain, rememberSignupDomain, SIGNUP_DOMAIN_KEY, SIGNUP_DOMAIN_TTL_MS } from '../src/lib/signup-intent';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.restoreAllMocks();
});

const stored = () => JSON.parse(localStorage.getItem(SIGNUP_DOMAIN_KEY) ?? 'null');

describe('signup domain storage', () => {
	it('keeps the normalised domain in localStorage (not sessionStorage) for 24 hours', () => {
		rememberSignupDomain(' München.DE ', 1000);
		expect(stored()).toEqual({ domain: 'xn--mnchen-3ya.de', expires: 1000 + 24 * 60 * 60 * 1000 });
		expect(SIGNUP_DOMAIN_TTL_MS).toBe(86_400_000);
		expect(sessionStorage.length).toBe(0);
		expect(readSignupDomain(2000)).toBe('xn--mnchen-3ya.de');
	});

	it('never stores a value that fails validation, so markup cannot reach the page', () => {
		for (const bad of ['<img src=x onerror=alert(1)>', 'https://evil.com', 'javascript:alert(1)', 'a b.com', '', null, undefined]) rememberSignupDomain(bad);
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});

	it('an invalid value does not replace a good one', () => {
		rememberSignupDomain('good.com');
		rememberSignupDomain('<script>');
		expect(readSignupDomain()).toBe('good.com');
	});

	it('drops an expired entry', () => {
		rememberSignupDomain('example.com', 0);
		expect(readSignupDomain(SIGNUP_DOMAIN_TTL_MS - 1)).toBe('example.com');
		expect(readSignupDomain(SIGNUP_DOMAIN_TTL_MS)).toBeNull();
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});

	it.each([
		['not JSON', '{nope'],
		['a bare string', '"example.com"'],
		['null', 'null'],
		['an array', '[]'],
		['no expiry', '{"domain":"example.com"}'],
		['a string expiry', '{"domain":"example.com","expires":"9999999999999"}'],
		['a tampered domain', JSON.stringify({ domain: '<img src=x onerror=alert(1)>', expires: Date.now() + 1e6 })],
		['a non-normalised domain', JSON.stringify({ domain: 'EXAMPLE.com', expires: Date.now() + 1e6 })],
		['a URL', JSON.stringify({ domain: 'https://example.com', expires: Date.now() + 1e6 })],
	])('re-validates on read and drops %s', (_n, raw) => {
		localStorage.setItem(SIGNUP_DOMAIN_KEY, raw);
		expect(readSignupDomain()).toBeNull();
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});

	it('clears, and clears only a matching domain with clearSignupDomainIf', () => {
		rememberSignupDomain('example.com');
		clearSignupDomainIf('other.com');
		expect(readSignupDomain()).toBe('example.com');
		clearSignupDomainIf('example.com');
		expect(readSignupDomain()).toBeNull();
		rememberSignupDomain('example.com');
		clearSignupDomain();
		expect(readSignupDomain()).toBeNull();
	});

	it('survives storage that throws', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
		expect(() => rememberSignupDomain('example.com')).not.toThrow();
		expect(readSignupDomain()).toBeNull();
		expect(() => clearSignupDomain()).not.toThrow();
		expect(() => clearSignupDomainIf('example.com')).not.toThrow();
		expect(captureSignupIntent({ pathname: '/signup', search: '?domain=example.com', hash: '' })).toBe('/#/signup');
	});
});

describe('captureSignupIntent', () => {
	it('path form: remembers the domain and returns the fixed address, never echoing the input', () => {
		const to = captureSignupIntent({ pathname: '/signup', search: '?domain=Example.com&utm=1', hash: '' });
		expect(to).toBe('/#/signup');
		expect(readSignupDomain()).toBe('example.com');
	});

	it('path form: with no or a bad domain it still sends the person to the sign-up screen and stores nothing', () => {
		expect(captureSignupIntent({ pathname: '/signup', search: '', hash: '' })).toBe('/#/signup');
		expect(captureSignupIntent({ pathname: '/signup', search: '?domain=%3Cimg%20src%3Dx%3E', hash: '' })).toBe('/#/signup');
		expect(captureSignupIntent({ pathname: '/signup', search: '?domain=https%3A%2F%2Fevil.com', hash: '' })).toBe('/#/signup');
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});

	it('hash form: remembers the domain and strips the query', () => {
		const to = captureSignupIntent({ pathname: '/', search: '', hash: '#/signup?domain=acme.io' });
		expect(to).toBe('#/signup');
		expect(readSignupDomain()).toBe('acme.io');
	});

	it('hash form: rejects an invalid domain but still strips the query', () => {
		expect(captureSignupIntent({ pathname: '/', search: '', hash: '#/signup?domain=a%40b.com' })).toBe('#/signup');
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});

	it('leaves every other URL alone', () => {
		for (const loc of [
			{ pathname: '/', search: '', hash: '' },
			{ pathname: '/', search: '?domain=acme.io', hash: '' },
			{ pathname: '/', search: '', hash: '#/signup' },
			{ pathname: '/', search: '', hash: '#/domains/1?domain=acme.io' },
			{ pathname: '/signup/extra', search: '?domain=acme.io', hash: '' },
		]) expect(captureSignupIntent(loc)).toBeNull();
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});
});

describe('#/signup is a public page', () => {
	it('has no workspace prefix, with or without a query', () => {
		expect(parseHash('#/signup')).toMatchObject({ workspaceId: null, isPublic: true, rest: '/signup' });
		expect(parseHash('#/signup?domain=x.com').isPublic).toBe(true);
		expect(parseHash('#/w/ws_1/signup').isPublic).toBe(false);
		expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBeNull();
	});
});
