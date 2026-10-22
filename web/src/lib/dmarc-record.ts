/** Pure DMARC record helpers shared by the setup wizard, the graduation wizard and the domain page. */

/** Matches the `p=` tag only (not `sp=`): it must start the record or follow a `;`. */
const POLICY_TAG = /(^|;\s*)p=[a-z]+/i;

/**
 * Recommended record: keeps every existing tag (other rua= addresses, sp=, fo=, pct=…), sets `p=` to
 * the target and appends our rua= address if it is not already there.
 */
export function buildRecommendedRecord(current: string | null, policy: string, rua: string): string {
	if (!current) return `v=DMARC1; p=${policy}; rua=mailto:${rua}`;
	let record = POLICY_TAG.test(current) ? current.replace(POLICY_TAG, `$1p=${policy}`) : `${current}; p=${policy}`;
	if (!record.includes(rua)) {
		record = /rua=/.test(record) ? record.replace(/rua=([^;]+)/, `rua=$1,mailto:${rua}`) : `${record}; rua=mailto:${rua}`;
	}
	return record;
}

/** The `p=` value of a record, lower-cased, or null. */
export function parseDmarcPolicy(record: string | null): string | null {
	return record?.match(/(?:^|;\s*)p=([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
}
