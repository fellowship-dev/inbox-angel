/**
 * A domain typed or carried in from outside (a link, the website), made safe to show and to send: the hostname in lower-case ASCII
 * (IDN as punycode), or null. Anything that is not a bare hostname is refused rather than repaired: no URL, path, userinfo, port,
 * percent-encoding, whitespace or control characters. The final shape is the server's rule for domains plus per-label limits.
 */
const SERVER_RULE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const LABEL = /^[a-z0-9-]{1,63}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// whitespace, / \ ? # @ : %, and control characters
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s/\\?#@:%\u0000-\u001f\u007f]/;

export function normalizeDomainInput(raw: string): string | null {
	if (typeof raw !== 'string') return null;
	let s = raw.trim().toLowerCase();
	if (s.endsWith('.')) s = s.slice(0, -1);
	if (s === '' || s.length > 253 || FORBIDDEN.test(s)) return null;

	let host: string;
	try {
		host = new URL(`http://${s}`).hostname;
	} catch {
		return null;
	}
	if (host.length > 253 || IPV4.test(host) || !SERVER_RULE.test(host)) return null;
	const labels = host.split('.');
	if (labels.length < 2) return null;
	for (const l of labels) {
		if (!LABEL.test(l) || l.startsWith('-') || l.endsWith('-')) return null;
	}
	return host;
}
