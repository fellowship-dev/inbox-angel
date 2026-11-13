/** Pure DKIM record helpers. */

/**
 * A DKIM key record with an empty `p=` tag: the key has been revoked (RFC 6376, section 3.6.1), so nothing
 * signed with it verifies. A CNAME target or a record with a key is not revoked.
 */
export function isRevokedDkimKey(record: string): boolean {
	return /(^|;)\s*p=\s*(;|$)/i.test(record.trim());
}
