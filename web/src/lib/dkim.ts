/** Pure DKIM record helpers. */

import { decodeTxtData } from '@inbox-angel/dns-checks/txt';

/**
 * A DKIM key record with an empty `p=` tag: the key has been revoked (RFC 6376, section 3.6.1), so nothing
 * signed with it verifies. A CNAME target or a record with a key is not revoked. Quoted TXT content
 * (`"v=DKIM1; p="`, or split strings as the Cloudflare API returns them) is read as DNS would serve it.
 */
export function isRevokedDkimKey(record: string): boolean {
	return /(^|;)\s*p=\s*(;|$)/i.test(decodeTxtData(record));
}

/**
 * A selector that can sign today: a TXT key with a non-empty base64 `p=` (not a DMARC or SPF record), or a CNAME target
 * (a host name, delegated to the provider). Revoked keys and other TXT content are not usable.
 */
export function isUsableDkimSelector(record: string): boolean {
	const t = decodeTxtData(record).trim();
	if (!/[=;]/.test(t)) return /^[a-z0-9.-]+\.[a-z]{2,}\.?$/i.test(t);
	if (/^v=\s*(DMARC1|spf1)/i.test(t)) return false;
	return /(^|;)\s*p=\s*[A-Za-z0-9+/]+={0,2}\s*(;|$)/.test(t);
}
