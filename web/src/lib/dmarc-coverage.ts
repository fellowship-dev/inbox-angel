import { enforcementLevel, hasReportAddress, parseDmarcPolicy, parseDmarcSp, parseDmarcTags } from './dmarc-record';
import type { OnboardingStatus } from './types';

/**
 * What covers a domain that has no DMARC record of its own, from the live onboarding status:
 *  - `own`: it has its own record (the caller handles that);
 *  - `inherited`: its organizational domain's record applies. `policy` is the effective one for this subdomain (the
 *    parent's `sp=` when it has one, else its `p=`; null with an `issue` when that record gives receivers no policy),
 *    `sp` is the parent's `sp=` tag (null when absent), `parentPolicy` its `p=`, `pct` the share of failing mail
 *    the policy covers, and `adkim`/`aspf` the parent's alignment modes when it sets them (null: the relaxed default);
 *  - `none`: no policy applies at all, so publishing `p=none` weakens nothing;
 *  - `unknown`: the lookup failed, the parent could not be read, or the server did not say, so nothing may be offered.
 * A record of its own replaces an inherited policy, so what is offered carries exactly the enforcement in force
 * (see `offerEnforcement`): never weaker, never stricter.
 */
export type DmarcCoverage =
	| { kind: 'own' }
	| { kind: 'unknown' }
	| { kind: 'none' }
	| { kind: 'inherited'; parent: string; policy: string | null; issue: string | null; pct: number; sp: string | null; parentPolicy: string | null; adkim: Alignment | null; aspf: Alignment | null };

type Alignment = 'r' | 's';
const alignment = (v: string | undefined): Alignment | null => (v?.toLowerCase() === 's' ? 's' : v?.toLowerCase() === 'r' ? 'r' : null);

/** The inherited coverage from the parent's live record: what applies to a subdomain that has no record of its own. */
export function inheritedCoverage(parent: string, record: string | null, policy: string | null, issue: string | null = null): Extract<DmarcCoverage, { kind: 'inherited' }> {
	const tags = parseDmarcTags(record);
	return {
		kind: 'inherited',
		parent,
		policy,
		issue,
		pct: enforcementLevel(record).pct,
		sp: parseDmarcSp(record),
		parentPolicy: parseDmarcPolicy(record),
		adkim: alignment(tags.adkim),
		aspf: alignment(tags.aspf),
	};
}

export function dmarcCoverage(status: Pick<OnboardingStatus, 'dmarc'> | null | undefined, lookupFailed = false): DmarcCoverage {
	if (!status || lookupFailed) return { kind: 'unknown' };
	if (status.dmarc.found) return { kind: 'own' };
	const e = status.dmarc.effective;
	// Absent (a server that does not say) and null (DNS could not say) are both unknown: nothing may be offered.
	if (!e) return { kind: 'unknown' };
	if (e.inherited_from) return inheritedCoverage(e.inherited_from, e.record ?? null, e.policy, e.issue);
	// No own record, yet a policy or an issue that is not inherited: the answers disagree, so do not guess.
	if (e.policy || e.issue) return { kind: 'unknown' };
	return { kind: 'none' };
}

export interface Enforcement {
	policy: 'none' | 'quarantine' | 'reject';
	/** Share of failing mail the policy applies to; 100 unless the inherited record says less. */
	pct: number;
	/** The inherited alignment modes, carried as published (strict alignment is part of the enforcement in force). */
	adkim?: Alignment;
	aspf?: Alignment;
}

/**
 * The enforcement a record of the domain's own must carry so that publishing it changes nothing about how failing
 * mail is handled: the inherited policy and pct when it enforces, else p=none. Null when nothing may be offered.
 */
export function offerEnforcement(c: DmarcCoverage): Enforcement | null {
	if (c.kind === 'unknown') return null;
	const align = c.kind === 'inherited' ? { ...(c.adkim ? { adkim: c.adkim } : {}), ...(c.aspf ? { aspf: c.aspf } : {}) } : {};
	if (c.kind === 'inherited' && (c.policy === 'quarantine' || c.policy === 'reject')) return { policy: c.policy, pct: c.pct, ...align };
	return { policy: 'none', pct: 100, ...align };
}

/** A new record at exactly `e`, with the report address when there is one (`pct=` only when under 100). */
export function recordFor(e: Enforcement, rua: string | null | undefined): string {
	const parts = ['v=DMARC1', `p=${e.policy}`];
	if (e.pct < 100) parts.push(`pct=${e.pct}`);
	if (e.adkim) parts.push(`adkim=${e.adkim}`);
	if (e.aspf) parts.push(`aspf=${e.aspf}`);
	if (hasReportAddress(rua)) parts.push(`rua=mailto:${rua.trim()}`);
	return parts.join('; ');
}

/** "p=quarantine at pct=5", or for an inherited sp=: "the inherited sp=quarantine as its p=quarantine at pct=5". */
export function keptEnforcement(c: DmarcCoverage, e: Enforcement): string {
	const at = e.pct < 100 ? ` at pct=${e.pct}` : '';
	return c.kind === 'inherited' && c.sp ? `the inherited sp=${e.policy} as its p=${e.policy}${at}` : `p=${e.policy}${at}`;
}

/** One plain sentence on an inherited policy: where it comes from and what it means for mail from this name. */
export function inheritedSentence(domain: string, c: Extract<DmarcCoverage, { kind: 'inherited' }>): string {
	if (!c.policy) {
		return `${domain} has no DMARC record of its own, and the record it would inherit from ${c.parent} gives receivers no policy (${c.issue === 'multiple' ? 'there are several' : 'it has no valid p='}). Fix the record at _dmarc.${c.parent}.`;
	}
	// Where the policy comes from: the parent's sp= for its subdomains, or its p=.
	const source = c.sp
		? `${domain} has no DMARC record of its own. ${c.parent}'s policy for its subdomains is sp=${c.sp}${c.parentPolicy && c.parentPolicy !== c.sp ? ` (its own p=${c.parentPolicy} does not apply here)` : ''}`
		: `${domain} has no DMARC record of its own and inherits p=${c.policy} from ${c.parent}`;
	if (c.policy === 'none') {
		return `${source}: receivers still deliver mail that fails SPF and DKIM. Tighten it at _dmarc.${c.parent} once you know every service sending as this name passes.`;
	}
	const verb = c.policy === 'reject' ? 'reject' : 'quarantine';
	const scope = c.pct < 100 ? `${c.pct}% of the mail from this name that fails SPF and DKIM (pct=${c.pct}); the rest is handled one step more leniently` : 'mail from this name that fails SPF and DKIM';
	return `${source}: receivers ${c.pct < 100 ? '' : 'already '}${verb} ${scope}. A record at ${domain} would replace that policy.`;
}
