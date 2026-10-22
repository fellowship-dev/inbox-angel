import type { Severity } from '../../../components/wizard/SeverityBadge';
import { findUnsignedSpfProviders } from '@inbox-angel/dns-checks/email-service-providers';
import type { OnboardingStatus, WizardState } from '../../../lib/types';

export const STEP_KEYS = ['domain', 'spf', 'dkim', 'dmarc', 'routing'] as const satisfies readonly (keyof WizardState)[];
export const STEP_LABELS = ['Domain', 'SPF', 'DKIM', 'DMARC', 'Routing'] as const;
export const STEP_COUNT = STEP_KEYS.length;

export const DEFAULT_WIZARD: WizardState = { domain: 'not_started', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' };

/** `:step` from the URL: 1-indexed, null when absent or not a number. */
export function parseStep(param: string | undefined): number | null {
	if (param === undefined) return null;
	const n = Number.parseInt(param, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * The URL step (1-indexed) to show. A domain already exists, so step 1 is never shown: a missing, 1 or
 * out-of-range step resumes at the first later step that is still `not_started` (skipped and complete
 * steps are not revisited on their own), falling back to SPF.
 */
export function resolveStep(urlStep: number | null, wizard: WizardState): number {
	if (urlStep !== null && urlStep >= 2 && urlStep <= STEP_COUNT) return urlStep;
	const first = STEP_KEYS.findIndex((k, i) => i > 0 && wizard[k] === 'not_started');
	return (first > 0 ? first : 1) + 1;
}

export const completedCount = (w: WizardState): number => STEP_KEYS.filter((k) => w[k] === 'complete').length;

export type DnsCheckName = 'spf' | 'dmarc' | 'authRecord' | 'mx' | 'nullSender' | 'dkim';

const PREFIX: Record<DnsCheckName, string> = {
	spf: 'spf:',
	dmarc: 'dmarc:',
	authRecord: 'auth record:',
	mx: 'mx:',
	nullSender: 'null-sender',
	dkim: 'dkim ',
};

/** The `dns_errors` entries belonging to one check. A non-empty result means "unknown", never "missing". */
export function dnsErrorsFor(status: Pick<OnboardingStatus, 'dns_errors'>, check: DnsCheckName): string[] {
	return (status.dns_errors ?? []).filter((e) => e.startsWith(PREFIX[check]));
}

/** "spf: timeout" -> "timeout" */
export const dnsErrorDetail = (entry: string): string => entry.replace(/^[^:]*:\s*/, '');

export function spfSeverity(spf: OnboardingStatus['spf'], lookupFailed = false): Severity {
	if (lookupFailed) return 'unknown';
	if (!spf.record) return 'warning';
	const c = spf.lookup_count ?? 0;
	if (c > 9) return 'error';
	if (c >= 8) return 'warning';
	return 'good';
}

export function dkimSeverity(dkim: OnboardingStatus['dkim'], dmarcPolicy: string | null, unsignedCount: number, lookupsFailed = false): Severity {
	const hasDkim = dkim.selectors.length > 0;
	// Some selector lookups failed and none succeeded: "no DKIM" would be a guess.
	if (!hasDkim && lookupsFailed) return 'unknown';
	const strict = dmarcPolicy === 'quarantine' || dmarcPolicy === 'reject';
	if (hasDkim && unsignedCount === 0) return 'good';
	if (strict) return 'warning';
	return 'info';
}

export function dmarcSeverity(d: OnboardingStatus['dmarc'], lookupFailed = false): Severity {
	if (lookupFailed) return 'unknown';
	if (!d.found) return 'error';
	if (!d.has_our_rua) return 'warning';
	return 'info';
}

export function routingSeverity(r: OnboardingStatus['routing'], lookupsFailed = false): Severity {
	const allGood = r.mx_found && r.destination_verified && r.null_sender_spf && r.null_sender_dmarc;
	if (allGood) return 'good';
	if (lookupsFailed) return 'unknown';
	if (r.mx_found || r.destination_verified) return 'warning';
	return 'error';
}

export const unsignedProviders = (dkim: OnboardingStatus['dkim'], spfRecord: string | null) => findUnsignedSpfProviders(dkim.selectors, spfRecord);
