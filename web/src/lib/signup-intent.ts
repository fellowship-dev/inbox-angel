/**
 * The domain a person asked to monitor before they had an account (the website sends `/signup?domain=…`).
 *
 * It is kept in localStorage, not sessionStorage: the verification email opens a new tab, which has a fresh sessionStorage. It only
 * ever pre-fills a field the person must confirm with Continue. It is never submitted on its own and never used in a URL, a
 * redirect, a callback or as HTML (React text only). It expires with the verification link (24 hours), and a value that does not
 * pass `normalizeDomainInput` is never stored and is dropped when read.
 */
import { normalizeDomainInput } from './domain-input';

export const SIGNUP_DOMAIN_KEY = 'ia_signup_domain';
export const SIGNUP_DOMAIN_TTL_MS = 24 * 60 * 60 * 1000;

/** Store the requested domain. Anything that is not a plain hostname is ignored. */
export function rememberSignupDomain(raw: string | null | undefined, now = Date.now()): void {
	const domain = typeof raw === 'string' ? normalizeDomainInput(raw) : null;
	if (!domain) return;
	try {
		localStorage.setItem(SIGNUP_DOMAIN_KEY, JSON.stringify({ domain, expires: now + SIGNUP_DOMAIN_TTL_MS }));
	} catch {
		/* storage unavailable: the person just types it */
	}
}

export function clearSignupDomain(): void {
	try {
		localStorage.removeItem(SIGNUP_DOMAIN_KEY);
	} catch {
		/* ignore */
	}
}

/** The remembered domain, re-validated; an expired, invalid or garbage entry is removed and reads as null. */
export function readSignupDomain(now = Date.now()): string | null {
	try {
		const raw = localStorage.getItem(SIGNUP_DOMAIN_KEY);
		if (raw === null) return null;
		let entry: unknown;
		try {
			entry = JSON.parse(raw);
		} catch {
			entry = null;
		}
		const { domain, expires } = (entry && typeof entry === 'object' ? entry : {}) as { domain?: unknown; expires?: unknown };
		const valid = typeof domain === 'string' && typeof expires === 'number' && expires > now && normalizeDomainInput(domain) === domain;
		if (!valid) {
			localStorage.removeItem(SIGNUP_DOMAIN_KEY);
			return null;
		}
		return domain as string;
	} catch {
		return null;
	}
}

/** Clear the remembered domain once a submit for exactly that domain has worked. */
export function clearSignupDomainIf(domain: string): void {
	if (readSignupDomain() === domain) clearSignupDomain();
}

const SIGNUP_URL = '/#/signup';

/**
 * Run before the app renders. For `/signup?domain=…` (path form) and `#/signup?domain=…` (hash form): remember the domain and return
 * the URL to replace the address bar with, which is a fixed string and never contains the input. Null: nothing to do.
 */
export function captureSignupIntent(loc: { pathname: string; search: string; hash: string }, now = Date.now()): string | null {
	if (loc.pathname === '/signup') {
		rememberSignupDomain(new URLSearchParams(loc.search).get('domain'), now);
		return SIGNUP_URL;
	}
	const m = /^#\/signup\?(.*)$/.exec(loc.hash);
	if (m) {
		rememberSignupDomain(new URLSearchParams(m[1]).get('domain'), now);
		return '#/signup';
	}
	return null;
}
