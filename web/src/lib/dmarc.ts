import { enforcementLevel, parseDmarcSp, weakerSubdomainPolicy } from './dmarc-record';
import type { Domain, WizardState } from './types';

/** What people paste into the box: trim, lowercase, drop a scheme and one trailing slash. */
export function normalizeDomain(input: string): string {
	return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export { buildRecommendedRecord } from './dmarc-record';

/** `sp=` tag of a live record, if any. */
export function spTag(record: string | null): string | null {
	return parseDmarcSp(record);
}

export type GuidanceTone = 'neutral' | 'warning' | 'info' | 'danger' | 'success';

export interface Guidance {
	tone: GuidanceTone;
	title: string;
	body: string;
	/** Policy to offer an upgrade to (links to the DMARC wizard). */
	upgradeTo?: 'quarantine' | 'reject';
}

/**
 * Pure guidance from policy, the window's pass rate (percent) and whether any report arrived. `liveRecord` is the
 * record read from DNS, when it was: it adds what `pct=` and `sp=` change, so "enforced" is only said where it is true.
 */
export function getGuidance(domain: Pick<Domain, 'dmarc_policy' | 'domain' | 'rua_address'>, passRate: number | null, hasData: boolean, liveRecord: string | null = null): Guidance {
	const policy = domain.dmarc_policy ?? 'none';

	if (!hasData) {
		return {
			tone: 'neutral',
			title: 'Waiting for first reports',
			body: 'No DMARC reports yet. Mail servers collect them throughout the day and send a batch once every 24 hours, so your first report usually arrives within a day of adding your DNS record. Nothing to do but wait.',
		};
	}
	if (policy === 'none') {
		return {
			tone: 'warning',
			title: 'Monitoring only, not enforcing',
			body: "You're observing mail flows but DMARC is not protecting your domain yet. Once your pass rate stays above 95% for a few days, switch to quarantine.",
			upgradeTo: 'quarantine',
		};
	}
	if (policy === 'quarantine') {
		if (passRate !== null && passRate >= 90) {
			return {
				tone: 'info',
				title: 'Ready to enforce',
				body: `Pass rate is ${passRate}%, so your legitimate mail is well aligned. You can safely move to reject to stop spoofed mail from reaching inboxes.`,
				upgradeTo: 'reject',
			};
		}
		return {
			tone: 'warning',
			title: 'Not ready for reject yet',
			body: `Pass rate is ${passRate ?? 'n/a'}%, so some legitimate mail is failing DMARC. Investigate the failing sources below before tightening your policy.`,
		};
	}
	if (policy === 'reject') {
		if (passRate !== null && passRate < 70) {
			return {
				tone: 'danger',
				title: 'Legitimate mail may be blocked',
				body: `Pass rate is ${passRate}% under a reject policy, so some of your own mail is likely being rejected by recipients. Check the failing sources below urgently.`,
			};
		}
		const live = enforcementLevel(liveRecord);
		if (live.policy === 'reject' && live.level === 'partial') {
			return {
				tone: 'warning',
				title: `Partially enforced: ${live.pct}%`,
				body: `DMARC is at reject with pct=${live.pct}, so it applies to only ${live.pct}% of mail that fails. Receivers handle the rest one policy level weaker. Pass rate is ${passRate ?? 'n/a'}%. Raise pct to 100 (or remove it) once your failing sources are fixed.`,
			};
		}
		const spWeaker = live.policy === 'reject' ? weakerSubdomainPolicy(liveRecord) : null;
		if (spWeaker) {
			return {
				tone: 'warning',
				title: 'Enforced on this domain; subdomains are not',
				body: `DMARC is enforced at reject for ${domain.domain} itself, and the pass rate is ${passRate ?? 'n/a'}%. Subdomains without their own DMARC record follow sp=${spWeaker}, so mail from them is not rejected. Set sp=reject to enforce them too.`,
			};
		}
		return {
			tone: 'success',
			title: 'Fully protected',
			body: `DMARC is enforced at reject. Pass rate is ${passRate ?? 'n/a'}%. Spoofed mail claiming to be from ${domain.domain} is rejected by receiving servers.`,
		};
	}
	return { tone: 'neutral', title: 'Unknown policy', body: 'Could not determine guidance for the current policy.' };
}

export interface DayStat {
	total: number;
	passed: number;
	failed: number;
}

export function sumStats(stats: DayStat[]): { total: number; passed: number; failed: number; passRate: number | null } {
	const total = stats.reduce((n, r) => n + r.total, 0);
	const passed = stats.reduce((n, r) => n + r.passed, 0);
	const failed = stats.reduce((n, r) => n + r.failed, 0);
	return { total, passed, failed, passRate: total > 0 ? Math.round((passed / total) * 100) : null };
}

const SETUP_STEPS = ['domain', 'spf', 'dkim', 'dmarc', 'routing'] as const;

/**
 * Setup progress out of the wizard's five steps, counted the same way everywhere: the wizard's "n of 5 steps
 * complete" and the "Continue setup n/5" links. A domain that exists has done the domain step, even when it was
 * added outside the wizard and its stored state still says not_started.
 * `hosted`: the fifth step (Reports) only says reports are not connected, so it is never done and never counted:
 * progress is out of four.
 */
export function wizardProgress(state: WizardState, { hosted = false }: { hosted?: boolean } = {}): { done: number; skipped: number; total: number; nextStep: number } {
	const steps = hosted ? SETUP_STEPS.filter((k) => k !== 'routing') : SETUP_STEPS;
	const stateOf = (k: (typeof SETUP_STEPS)[number]) => (k === 'domain' ? 'complete' : state[k]);
	const done = steps.filter((k) => stateOf(k) === 'complete').length;
	const skipped = steps.filter((k) => stateOf(k) === 'skipped').length;
	const firstIncomplete = steps.findIndex((k, i) => i > 0 && state[k] !== 'complete');
	return { done, skipped, total: steps.length, nextStep: firstIncomplete > 0 ? firstIncomplete + 1 : 2 };
}

/**
 * Subdomain inheritance (RFC 7489 §6.3): with no sp= tag the parent's p= applies to subdomains.
 * `kind`: none = parent has no DMARC, enforced = sp/p is reject, open = anything weaker.
 */
export function inheritanceVerdict(pc: { dmarc_policy: string | null; dmarc_sp: string | null; has_dmarc: boolean }): { kind: 'none' | 'enforced' | 'open'; via: string } {
	if (!pc.has_dmarc) return { kind: 'none', via: '' };
	const effective = pc.dmarc_sp ?? pc.dmarc_policy;
	if (effective === 'reject') return { kind: 'enforced', via: pc.dmarc_sp === 'reject' ? 'sp=reject' : 'p=reject (sp= not set, inherits p=)' };
	return { kind: 'open', via: pc.dmarc_sp !== null ? `sp=${pc.dmarc_sp}` : `no sp= tag (inherits p=${pc.dmarc_policy ?? 'none'})` };
}
