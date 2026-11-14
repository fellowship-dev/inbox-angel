import { enforcementLevel } from './dmarc-record';
import type { OnboardingStatus } from './types';

/**
 * What covers a domain that has no DMARC record of its own, from the live onboarding status:
 *  - `own`: it has its own record (the caller handles that);
 *  - `inherited`: its organizational domain's record applies (`policy` is the effective one, `sp=` else `p=`; null with an
 *    `issue` when that record gives receivers no policy; `pct` is the share of failing mail that policy covers);
 *  - `none`: no policy applies at all, so publishing `p=none` weakens nothing;
 *  - `unknown`: the lookup failed (or the parent could not be read), so nothing may be offered.
 * A record of its own replaces an inherited policy, so nothing offered may be weaker than it (see `offerPolicy`).
 * `effective` absent altogether means a server that predates the field; this dashboard ships with its server, so that
 * only happens in tests and is read as "no policy".
 */
export type DmarcCoverage =
	| { kind: 'own' }
	| { kind: 'unknown' }
	| { kind: 'none' }
	| { kind: 'inherited'; parent: string; policy: string | null; issue: string | null; pct: number };

export function dmarcCoverage(status: Pick<OnboardingStatus, 'dmarc'> | null | undefined, lookupFailed = false): DmarcCoverage {
	if (!status || lookupFailed) return { kind: 'unknown' };
	if (status.dmarc.found) return { kind: 'own' };
	const e = status.dmarc.effective;
	if (e === undefined) return { kind: 'none' };
	if (!e) return { kind: 'unknown' };
	if (e.inherited_from) return { kind: 'inherited', parent: e.inherited_from, policy: e.policy, issue: e.issue, pct: enforcementLevel(e.record ?? null).pct };
	// No own record, yet a policy or an issue that is not inherited: the answers disagree, so do not guess.
	if (e.policy || e.issue) return { kind: 'unknown' };
	return { kind: 'none' };
}

/**
 * The weakest policy a record of the domain's own may carry: the inherited one when it enforces, else none. Null when
 * nothing may be offered (the policy that applies is unknown). Never weaker than the effective policy, in any mode.
 */
export function offerPolicy(c: DmarcCoverage): 'none' | 'quarantine' | 'reject' | null {
	if (c.kind === 'unknown') return null;
	if (c.kind === 'inherited' && (c.policy === 'quarantine' || c.policy === 'reject')) return c.policy;
	return 'none';
}

/** One plain sentence on an inherited policy: where it comes from and what it means for mail from this name. */
export function inheritedSentence(domain: string, c: Extract<DmarcCoverage, { kind: 'inherited' }>): string {
	if (!c.policy) {
		return `${domain} has no DMARC record of its own, and the record it would inherit from ${c.parent} gives receivers no policy (${c.issue === 'multiple' ? 'there are several' : 'it has no valid p='}). Fix the record at _dmarc.${c.parent}.`;
	}
	if (c.policy === 'none') {
		return `${domain} has no DMARC record of its own and inherits p=none from ${c.parent}: receivers still deliver mail that fails SPF and DKIM. Tighten it at _dmarc.${c.parent} once you know every service sending as this name passes.`;
	}
	const verb = c.policy === 'reject' ? 'reject' : 'quarantine';
	const scope = c.pct < 100 ? `${c.pct}% of the mail from this name that fails SPF and DKIM (pct=${c.pct}); the rest is handled one step more leniently` : 'mail from this name that fails SPF and DKIM';
	return `${domain} has no DMARC record of its own and inherits p=${c.policy} from ${c.parent}: receivers ${c.pct < 100 ? '' : 'already '}${verb} ${scope}. A record at ${domain} would replace that policy.`;
}
