/** Pure DMARC record helpers shared by the setup wizard, the graduation wizard and the domain page. */

/** Matches the `p=` tag only (not `sp=`): it must start the record or follow a `;`. */
const POLICY_TAG = /(^|;\s*)p=[a-z]+/i;

/**
 * True when `rua` is a usable report address. A domain added before a reports domain was configured has an
 * empty one, and a missing field arrives as undefined: neither may end up in a record as `mailto:`.
 */
export function hasReportAddress(rua: string | null | undefined): rua is string {
	return typeof rua === 'string' && /^[^\s@;,]+@[^\s@;,]+$/.test(rua.trim());
}

/**
 * Recommended record: keeps every existing tag (other rua= addresses, sp=, fo=, pct=…), sets `p=` to
 * the target and appends our rua= address if it is not already there. Without a usable report address
 * only `p=` changes: the record never gets a `mailto:` with an empty or undefined address.
 */
export function buildRecommendedRecord(current: string | null, policy: string, rua: string | null | undefined): string {
	const ours = hasReportAddress(rua) ? rua.trim() : null;
	if (!current) return ours ? `v=DMARC1; p=${policy}; rua=mailto:${ours}` : `v=DMARC1; p=${policy}`;
	let record = POLICY_TAG.test(current) ? current.replace(POLICY_TAG, `$1p=${policy}`) : `${current}; p=${policy}`;
	if (ours && !record.includes(ours)) {
		record = /rua=/.test(record) ? record.replace(/rua=([^;]+)/, `rua=$1,mailto:${ours}`) : `${record}; rua=mailto:${ours}`;
	}
	return record;
}

/** The `p=` value of a record, lower-cased, or null. */
export function parseDmarcPolicy(record: string | null): string | null {
	return record?.match(/(?:^|;\s*)p=([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
}
