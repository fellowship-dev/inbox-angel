import type { Domain, WizardState } from './types';

export type DomainStatus = 'good' | 'warning' | 'danger';

/** Overview health from policy and the 7-day pass rate (0..1, null without data). */
export function computeStatus(policy: Domain['dmarc_policy'], passRate: number | null): DomainStatus {
	if (policy === 'none' || policy === null) return 'danger';
	if (passRate !== null && passRate < 0.7) return 'danger';
	if (policy === 'quarantine' || (passRate !== null && passRate < 0.9)) return 'warning';
	return 'good';
}

/** What people paste into the box: trim, lowercase, drop a scheme and one trailing slash. */
export function normalizeDomain(input: string): string {
	return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export { buildRecommendedRecord } from './dmarc-record';

/** `sp=` tag of a live record, if any. */
export function spTag(record: string | null): string | null {
	return record ? (record.match(/\bsp=([a-z]+)/)?.[1] ?? null) : null;
}

export type GuidanceTone = 'neutral' | 'warning' | 'info' | 'danger' | 'success';

export interface Guidance {
	tone: GuidanceTone;
	title: string;
	body: string;
	/** Policy to offer an upgrade to (links to the DMARC wizard). */
	upgradeTo?: 'quarantine' | 'reject';
}

/** Pure guidance from policy, the window's pass rate (percent) and whether any report arrived. */
export function getGuidance(domain: Pick<Domain, 'dmarc_policy' | 'domain' | 'rua_address'>, passRate: number | null, hasData: boolean): Guidance {
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

/** Steps done out of the wizard's five; used for "Continue setup n/5". */
export function wizardProgress(state: WizardState): { done: number; total: number; nextStep: number } {
	const values: string[] = Object.values(state);
	const done = values.filter((v) => v === 'complete').length;
	const keys = ['domain', 'spf', 'dkim', 'dmarc', 'routing'] as const;
	const firstIncomplete = keys.findIndex((k, i) => i > 0 && state[k] !== 'complete');
	return { done, total: values.length, nextStep: firstIncomplete > 0 ? firstIncomplete + 1 : 2 };
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
