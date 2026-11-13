/** Pure DMARC record helpers shared by the setup wizard, the graduation wizard and the domain page. */

import { parseDmarcTags, readDmarcTag } from '@inbox-angel/dns-checks/dmarc-tags';

/**
 * True when `rua` is a usable report address. A domain added before a reports domain was configured has an
 * empty one, and a missing field arrives as undefined: neither may end up in a record as `mailto:`.
 */
export function hasReportAddress(rua: string | null | undefined): rua is string {
	return typeof rua === 'string' && /^[^\s@;,]+@[^\s@;,]+$/.test(rua.trim());
}

// The one RFC 7489 tag parser, shared with the server checks and the daily refresh.
export { parseDmarcTags };
const readTag = readDmarcTag;

/** The record with its first `key` tag rewritten in place (its leading whitespace kept), or null when it has none. */
function rewriteTag(record: string, key: string, value: (old: string) => string): string | null {
	const parts = record.split(';');
	const i = parts.findIndex((part) => readTag(part)?.key === key);
	if (i < 0) return null;
	const part = parts[i] ?? '';
	parts[i] = `${/^\s*/.exec(part)?.[0] ?? ''}${key}=${value(readTag(part)?.value ?? '')}`;
	return parts.join(';');
}

const withoutTrailingSemicolon = (record: string) => record.replace(/[;\s]+$/, '');

/** The address of one rua= entry: no `mailto:`, no `!size` limit, lower-cased (addresses are compared case-insensitively). */
const ruaAddress = (entry: string) => entry.trim().replace(/^mailto:/i, '').replace(/![^,]*$/, '').toLowerCase();

/**
 * Recommended record: keeps every existing tag (other rua= addresses, sp=, fo=, pct=…), sets `p=` to
 * the target and appends our rua= address if it is not already there (in any letter case). An existing `p=` is
 * rewritten in place, never duplicated. Without a usable report address only `p=` changes: the record never gets
 * a `mailto:` with an empty or undefined address.
 */
export function buildRecommendedRecord(current: string | null, policy: string, rua: string | null | undefined): string {
	const ours = hasReportAddress(rua) ? rua.trim() : null;
	if (!current) return ours ? `v=DMARC1; p=${policy}; rua=mailto:${ours}` : `v=DMARC1; p=${policy}`;
	let record = rewriteTag(current, 'p', () => policy) ?? `${withoutTrailingSemicolon(current)}; p=${policy}`;
	if (ours) {
		const have = (parseDmarcTags(record).rua ?? '').split(',').map(ruaAddress);
		if (!have.includes(ours.toLowerCase())) {
			record = rewriteTag(record, 'rua', (old) => `${old},mailto:${ours}`) ?? `${withoutTrailingSemicolon(record)}; rua=mailto:${ours}`;
		}
	}
	return record;
}

/** The `p=` value of a record, lower-cased, or null. */
export function parseDmarcPolicy(record: string | null): string | null {
	const p = parseDmarcTags(record).p;
	return p && /^[a-z]+$/i.test(p) ? p.toLowerCase() : null;
}

type PolicyName = 'none' | 'quarantine' | 'reject';

/** The `sp=` value (subdomain policy) when it is none / quarantine / reject; null when absent, empty or not valid (subdomains then inherit p=). */
export function parseDmarcSp(record: string | null | undefined): PolicyName | null {
	const sp = parseDmarcTags(record).sp?.toLowerCase();
	return sp === 'none' || sp === 'quarantine' || sp === 'reject' ? sp : null;
}

/** The `sp=` value as written when it is present but not a policy (`sp=bogus`); null otherwise. */
export function invalidDmarcSp(record: string | null | undefined): string | null {
	const raw = parseDmarcTags(record).sp;
	return raw && !parseDmarcSp(record) ? raw : null;
}

/** The `pct=` share of mail the policy applies to, 0 to 100. An absent or unreadable tag means 100, as for receivers. */
export function parseDmarcPct(record: string | null | undefined): number {
	const raw = parseDmarcTags(record).pct;
	if (raw === undefined || !/^\d{1,3}$/.test(raw)) return 100;
	return Math.min(100, Number(raw));
}

const STRENGTH: Record<PolicyName, number> = { none: 0, quarantine: 1, reject: 2 };

/** A valid `sp=` weaker than `p=` (so subdomains without their own record are enforced less than the domain), else null. */
export function weakerSubdomainPolicy(record: string | null | undefined): PolicyName | null {
	const p = parseDmarcPolicy(record ?? null);
	const sp = parseDmarcSp(record);
	return sp && (p === 'none' || p === 'quarantine' || p === 'reject') && STRENGTH[sp] < STRENGTH[p] ? sp : null;
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
