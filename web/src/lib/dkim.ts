/** Pure DKIM record helpers. */

import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';

/**
 * A DKIM key record with an empty `p=` tag: the key has been revoked (RFC 6376, section 3.6.1), so nothing
 * signed with it verifies. A CNAME target or a record with a key is not revoked. Quoted TXT content
 * (`"v=DKIM1; p="`, or split strings as the Cloudflare API returns them) is read as DNS would serve it.
 */
export function isRevokedDkimKey(record: string): boolean {
	return /(^|;)\s*p=\s*(;|$)/i.test(decodeTxtData(record));
}

