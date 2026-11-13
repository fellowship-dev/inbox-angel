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

/** Every tag of a record, keys lower-cased, first occurrence wins. Values are trimmed, nothing else is interpreted. */
export function parseDmarcTags(record: string | null | undefined): Record<string, string> {
	const tags: Record<string, string> = {};
	for (const part of (record ?? '').split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		const key = part.slice(0, i).trim().toLowerCase();
		if (key && !(key in tags)) tags[key] = part.slice(i + 1).trim();
	}
	return tags;
}

/** The `sp=` value (subdomain policy) of a record, lower-cased, or null when the tag is absent or empty. */
export function parseDmarcSp(record: string | null | undefined): string | null {
	return parseDmarcTags(record).sp?.toLowerCase() || null;
}

/** The `pct=` share of mail the policy applies to, 0 to 100. An absent or unreadable tag means 100, as for receivers. */
export function parseDmarcPct(record: string | null | undefined): number {
	const raw = parseDmarcTags(record).pct;
	if (raw === undefined || !/^\d{1,3}$/.test(raw)) return 100;
	return Math.min(100, Number(raw));
}

/**
 * How far a live record enforces: `full` only for p=reject applied to all mail, `partial` for quarantine/reject
 * on part of it (pct below 100), `quarantine` for p=quarantine on all mail, `none` for p=none, `unknown` otherwise.
 */
export function enforcementLevel(record: string | null | undefined): { level: 'full' | 'quarantine' | 'partial' | 'none' | 'unknown'; policy: string | null; pct: number } {
	const policy = parseDmarcPolicy(record ?? null);
	const pct = parseDmarcPct(record);
	if (policy === 'none') return { level: 'none', policy, pct };
	if (policy !== 'quarantine' && policy !== 'reject') return { level: 'unknown', policy, pct };
	if (pct < 100) return { level: 'partial', policy, pct };
	return { level: policy === 'reject' ? 'full' : 'quarantine', policy, pct };
}
