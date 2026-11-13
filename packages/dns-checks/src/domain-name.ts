/**
 * The one rule for "is this a domain we can monitor?", shared by the server (POST /api/domains, base-domain, bulk import, MCP,
 * ct-discover) and the dashboard's input. A domain typed or carried in from outside is made safe to show and to send: the hostname
 * in lower-case ASCII (IDN as punycode), or a reason it was refused. Nothing is repaired: no URL, path, userinfo, port,
 * percent-encoding, whitespace or control characters, no IPv4, no empty or over-long labels, no label that starts or ends with "-".
 *
 * Special-use names (RFC 6761, RFC 6762, RFC 7686, RFC 8375 and friends) are well-formed but have no public DNS to monitor.
 * Only the TLD decides: `example.com` and `example.org` are ordinary registrable domains, `printer.example` is not.
 */
/** `name` (special_use only) is the hostname that was refused, normalised, for the message. */
export type DomainNameResult = { ok: true; domain: string } | { ok: false; reason: 'invalid' } | { ok: false; reason: 'special_use'; name: string };

/** The server's historical shape: dots and hyphens in the body, at least one dot, a letters-only TLD of two or more. */
const SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const LABEL = /^[a-z0-9-]{1,63}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// whitespace, / \ ? # @ : %, and control characters
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s/\\?#@:%\u0000-\u001f\u007f]/;

/** Top-level names that never resolve on the public internet. `home.arpa` is matched as a suffix (it sits under `arpa`). */
export const SPECIAL_USE_TLDS: readonly string[] = ['local', 'internal', 'onion', 'test', 'invalid', 'example', 'localhost', 'arpa', 'alt'];
const SPECIAL_USE_SUFFIXES: readonly string[] = ['home.arpa'];

export function isSpecialUseName(host: string): boolean {
	const name = host.toLowerCase();
	const tld = name.slice(name.lastIndexOf('.') + 1);
	return SPECIAL_USE_TLDS.includes(tld) || SPECIAL_USE_SUFFIXES.some((s) => name === s || name.endsWith(`.${s}`));
}

export function normalizeDomainName(raw: string): DomainNameResult {
	const invalid = { ok: false, reason: 'invalid' } as const;
	if (typeof raw !== 'string') return invalid;
	let s = raw.trim().toLowerCase();
	if (s.endsWith('.')) s = s.slice(0, -1);
	if (s === '' || s.length > 253 || FORBIDDEN.test(s)) return invalid;

	let host: string;
	try {
		host = new URL(`http://${s}`).hostname;
	} catch {
		return invalid;
	}
	if (host === 'localhost') return { ok: false, reason: 'special_use', name: host };
	if (host.length > 253 || IPV4.test(host) || !SHAPE.test(host)) return invalid;
	const labels = host.split('.');
	if (labels.length < 2) return invalid;
	for (const l of labels) {
		if (!LABEL.test(l) || l.startsWith('-') || l.endsWith('-')) return invalid;
	}
	if (isSpecialUseName(host)) return { ok: false, reason: 'special_use', name: host };
	return { ok: true, domain: host };
}

export const INVALID_DOMAIN_MESSAGE = 'invalid domain format';

/** The sentence for a refused special-use name; the same on the server and in the dashboard. */
export const specialUseMessage = (name: string): string => `${name} is a special-use name and can't be monitored on the public internet.`;
