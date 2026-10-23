import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

/** Parses the Workers Static Assets `_headers` format: a path line followed by indented `Name: value` lines. */
function parseHeaders(text: string): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	let current: string | null = null;
	for (const raw of text.split('\n')) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue;
		if (/^\s/.test(raw)) {
			const i = raw.indexOf(':');
			if (current && i > 0) (out[current] ??= {})[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
		} else {
			current = raw.trim();
			out[current] = {};
		}
	}
	return out;
}

const headers = parseHeaders(readFileSync(resolve(root, 'public/_headers'), 'utf8'));
const get = (path: string, name: string): string => headers[path]?.[name] ?? '';
const all = new Proxy({} as Record<string, string>, { get: (_t, name: string) => get('/*', name) });
const directive = (csp: string, name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);

describe('public/_headers', () => {
	it('keeps the cache rules', () => {
		expect(get('/assets/*', 'Cache-Control')).toContain('immutable');
		expect(get('/index.html', 'Cache-Control')).toBe('no-cache');
	});

	it('has a CSP without unsafe script sources', () => {
		const csp = get('/*', 'Content-Security-Policy');
		expect(csp).toBeTruthy();
		const script = directive(csp, 'script-src') ?? '';
		expect(script).toContain("'self'");
		expect(script).not.toContain("'unsafe-inline'");
		expect(script).not.toContain("'unsafe-eval'");
		expect(script).not.toMatch(/\*|data:|blob:/);
		expect(csp).not.toContain("'unsafe-eval'");
		expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
		expect(directive(csp, 'object-src')).toBe("object-src 'none'");
		expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
		expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
		// Turnstile is the only third party the SPA loads.
		expect(script).toContain('https://challenges.cloudflare.com');
		expect(directive(csp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
	});

	it('sets the other hardening headers', () => {
		expect(all['X-Content-Type-Options']).toBe('nosniff');
		expect(all['X-Frame-Options']).toBe('DENY');
		expect(all['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
		expect(all['Permissions-Policy']).toBe('geolocation=(), camera=(), microphone=()');
		expect(all['Strict-Transport-Security']).toBe('max-age=63072000');
		expect(all['Cross-Origin-Opener-Policy']).toBe('same-origin');
	});
});

describe('index.html', () => {
	const html = readFileSync(resolve(root, 'index.html'), 'utf8');
	it('has no inline script, event handler or javascript: URL', () => {
		const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
		expect(scripts.length).toBeGreaterThan(0);
		for (const [, attrs, body] of scripts) {
			expect(attrs ?? '').toMatch(/\bsrc=/);
			expect((body ?? '').trim()).toBe('');
		}
		expect(html).not.toMatch(/\son[a-z]+\s*=/i);
		expect(html).not.toMatch(/javascript:/i);
	});
});
