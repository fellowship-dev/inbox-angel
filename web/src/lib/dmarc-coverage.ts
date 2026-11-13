import type { OnboardingStatus } from './types';

/**
 * What covers a domain that has no DMARC record of its own, from the live onboarding status:
 *  - `own`: it has its own record (the caller handles that);
 *  - `inherited`: its organizational domain's record applies (`policy` is the effective one, `sp=` else `p=`; null with an
 *    `issue` when that record gives receivers no policy);
 *  - `none`: no policy applies at all, so publishing `p=none` weakens nothing;
 *  - `unknown`: the lookup failed or the server did not say, so nothing may be offered.
 * A record of its own replaces an inherited policy, so a record is offered only for `none`.
 */
export type DmarcCoverage =
	| { kind: 'own' }
	| { kind: 'unknown' }
	| { kind: 'none' }
	| { kind: 'inherited'; parent: string; policy: string | null; issue: string | null };

export function dmarcCoverage(status: Pick<OnboardingStatus, 'dmarc'> | null | undefined, lookupFailed = false): DmarcCoverage {
	if (!status || lookupFailed) return { kind: 'unknown' };
	if (status.dmarc.found) return { kind: 'own' };
	const e = status.dmarc.effective;
	if (!e) return { kind: 'unknown' };
	if (e.inherited_from) return { kind: 'inherited', parent: e.inherited_from, policy: e.policy, issue: e.issue };
	// No own record, yet a policy or an issue that is not inherited: the answers disagree, so do not guess.
	if (e.policy || e.issue) return { kind: 'unknown' };
	return { kind: 'none' };
}

/** One plain sentence on an inherited policy: where it comes from and what it means for mail from this name. */
export function inheritedSentence(domain: string, c: Extract<DmarcCoverage, { kind: 'inherited' }>): string {
	if (!c.policy) {
		return `${domain} has no DMARC record of its own, and the record it would inherit from ${c.parent} gives receivers no policy (${c.issue === 'multiple' ? 'there are several' : 'it has no valid p='}). Fix the record at _dmarc.${c.parent}.`;
	}
	if (c.policy === 'none') {
		return `${domain} has no DMARC record of its own and inherits p=none from ${c.parent}: receivers still deliver mail that fails SPF and DKIM. Tighten it at _dmarc.${c.parent} once you know every service sending as this name passes.`;
	}
	return `${domain} has no DMARC record of its own and inherits p=${c.policy} from ${c.parent}: receivers already ${c.policy === 'reject' ? 'reject' : 'quarantine'} mail from this name that fails SPF and DKIM. There is nothing to publish here; a record here would replace that policy.`;
}
