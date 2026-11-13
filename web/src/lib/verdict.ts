import { STATUS_RANK, statusRank, type Level, type StatusKind } from '@inbox-angel/ui';
import { hasReportAddress } from './dmarc-record';
import { formatNumber } from './format';
import { applyHostedInputs, assessDomain, didNotResolve, dnsCheckLine, type HostedLevelInput } from './levels';
import type { Domain, DomainCheckSummary } from './types';

/**
 * "Am I done?" for one domain, in the status vocabulary shared with the website: one state, the level under it, one
 * sentence of what is true now (scoped: public DNS, then reports), and exactly one next action with who acts.
 *
 * Built only from what the overview already loads: the stored DNS facts (`check-summary`, refreshed by the daily
 * monitor and every time the domain page reads DNS), the report totals for the window, and hosted pointer status.
 * Unknown is never "not found": a field that was never read, or a check that failed, is Unknown and says so.
 */
export interface NextAction {
	label: string;
	/** Who acts, in plain words. */
	who: string;
	/** Where the action happens. Absent when there is nothing to open. */
	to?: string;
}

export interface DomainVerdict {
	status: StatusKind;
	/** Null when the level is not known (not checked, failed, does not resolve). */
	level: Level | null;
	/** What is true now, with its scope. */
	sentence: string;
	/** What the reports show, or that there are none. Null when it would add nothing. */
	evidence: string | null;
	/** When DNS was last read, or null for hosted domains (their level comes from pointer checks). */
	checked: string | null;
	next: NextAction;
}

/** Report totals for the window, or null while they load or when they failed. */
export interface ReportTotals {
	total: number;
	passed: number;
	failed: number;
	passRate: number | null;
	days: number;
}

export const WHO = {
	dns: 'You or your DNS manager',
	providers: 'You and your email providers',
	approver: 'An owner or admin',
	you: 'You',
	nobody: 'Nobody',
} as const;

const NOTHING: NextAction = { label: 'Nothing to do', who: WHO.nobody };

/** Pass rate at which a p=none domain's senders look ready for quarantine, and an enforced one looks healthy. */
const READY = 95;
/** Under enforcement, below this much of your own mail is probably being rejected or quarantined. */
const HARMFUL = 70;
/** The DMARC wizard offers p=reject from quarantine at this rate (lib/dmarc.ts getGuidance). */
const READY_FOR_REJECT = 90;

function reportsLine(domain: Pick<Domain, 'rua_address'>, r: ReportTotals | null | undefined): string {
	if (r === undefined) return 'Report totals are loading.';
	if (r === null) return 'Report totals could not be loaded, so this covers public DNS only.';
	if (r.total > 0 && r.passRate !== null) return `${r.passRate}% of ${formatNumber(r.total)} reported messages passed DMARC in the last ${r.days} days.`;
	if (!hasReportAddress(domain.rua_address)) return 'Reports are not connected for this domain, so nobody has confirmed that every sender passes.';
	return `No DMARC reports in the last ${r.days} days, so nobody has confirmed that every sender passes.`;
}

export function domainVerdict(
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address'>,
	s: DomainCheckSummary,
	reports: ReportTotals | null | undefined,
	hosted: HostedLevelInput | null = null,
): DomainVerdict {
	const page = `/domains/${domain.id}`;
	const name = domain.domain;
	const checked = hosted ? null : dnsCheckLine(s);
	const evidence = reportsLine(domain, reports);

	const unresolved = hosted ? null : didNotResolve(s);
	if (unresolved === 'now') {
		return {
			status: 'attention',
			level: null,
			sentence: `DNS says ${name} does not exist, so it has no SPF or DMARC records to check.`,
			evidence: null,
			checked,
			next: { label: 'Check the spelling, or remove this domain', who: WHO.you, to: `${page}/settings` },
		};
	}
	if (unresolved === 'at-last-good-check') {
		return {
			status: 'unknown',
			level: null,
			sentence: 'At the last good check DNS said this name does not exist. The latest check got no answer, so this may have changed.',
			evidence: null,
			checked,
			next: { label: 'Open the domain to check it again', who: WHO.you, to: page },
		};
	}

	const { summary: sum, unverified } = hosted ? applyHostedInputs(s, hosted) : { summary: s, unverified: [] as string[] };
	const a = assessDomain(sum, hosted ? { nullMeans: 'missing' } : undefined);
	const nullMeansUnknown = !hosted && !s.dns_checked_at;
	const hasSpf = !!sum.spf_record;
	const policy = sum.dmarc_policy;
	const issue = policy ? null : (sum.dmarc_issue ?? null);
	const spfUnknown = !hasSpf && nullMeansUnknown;
	const dmarcUnknown = !policy && !issue && nullMeansUnknown;
	// DMARC known to give no policy settles level 0 whatever SPF is; otherwise both must be known.
	const levelKnown = (!spfUnknown && !dmarcUnknown) || (!dmarcUnknown && !policy);
	const level: Level | null = levelKnown ? a.level : null;
	const at = `_dmarc.${sum.dmarc_inherited_from ?? name}`;
	const so = sum.dmarc_inherited_from ? `, inherited from ${sum.dmarc_inherited_from}, so` : ', so';
	const setup = (step: number) => `${page}/setup/${step}`;

	// Records we wrote in our zone that the customer's DNS does not point to yet.
	if (hosted && unverified.length > 0) {
		const failed = unverified.some((p) => hosted.pointer_status[p as keyof HostedLevelInput['pointer_status']] === 'error');
		const names = unverified.map((p) => ({ spf: 'SPF', dmarc: 'DMARC', mta_sts: 'MTA-STS' })[p as 'spf']).join(', ');
		return {
			status: failed ? 'unknown' : 'prepared',
			level,
			sentence: failed
				? `The last lookup of your ${names} pointer failed, so it is not counted as published.`
				: `Your ${names} record is written, but public DNS does not point to it yet.`,
			evidence,
			checked,
			next: failed ? { label: 'Open the domain to check the pointers again', who: WHO.you, to: page } : { label: 'Add the pointer records to your DNS', who: WHO.dns, to: page },
		};
	}

	// What public DNS shows that is wrong, most basic first (the setup wizard's order: SPF, then DMARC).
	if (!spfUnknown && !hasSpf && !dmarcUnknown && !policy && !issue) {
		return { status: 'attention', level, sentence: `Public DNS shows no SPF and no DMARC record, so receivers cannot verify mail from ${name}.`, evidence: null, checked, next: { label: 'Publish an SPF record', who: WHO.dns, to: setup(2) } };
	}
	if (!spfUnknown && !hasSpf) {
		return { status: 'attention', level, sentence: `Public DNS shows no SPF record, so receivers cannot tell which servers may send for ${name}.`, evidence: null, checked, next: { label: 'Publish an SPF record', who: WHO.dns, to: setup(2) } };
	}
	if (issue === 'multiple') {
		return { status: 'attention', level, sentence: `Public DNS shows several DMARC records at ${at}, so receivers ignore all of them.`, evidence: null, checked, next: { label: 'Keep one DMARC record and delete the others', who: WHO.dns, to: page } };
	}
	if (issue === 'invalid') {
		return { status: 'attention', level, sentence: `The DMARC record at ${at} has no valid p= policy, so receivers ignore it.`, evidence: null, checked, next: { label: 'Fix the DMARC record', who: WHO.dns, to: setup(4) } };
	}
	if (!dmarcUnknown && !policy) {
		return { status: 'attention', level, sentence: 'Public DNS shows SPF but no DMARC record, so receivers get no instruction for mail that fails.', evidence: null, checked, next: { label: 'Publish a DMARC record with p=none', who: WHO.dns, to: setup(4) } };
	}

	if (spfUnknown || dmarcUnknown) {
		const failed = s.dns_check_status === 'failed';
		const known = [hasSpf ? 'SPF is published' : null, policy ? `DMARC is at p=${policy}` : null].filter(Boolean).join(' and ');
		const rest = failed ? (known ? 'The last DNS check failed, so the rest is not confirmed.' : 'The last DNS check failed, so nothing is confirmed yet.') : known ? 'The rest has not been read from DNS yet.' : 'Nothing has been read from DNS for this domain yet.';
		return {
			status: 'unknown',
			level,
			sentence: known ? `${known}. ${rest}` : rest,
			evidence: null,
			checked,
			next: { label: failed ? 'Open the domain to check it again' : 'Open the domain to read its records from DNS', who: WHO.you, to: page },
		};
	}

	const rate = reports?.total ? reports.passRate : null;
	const fixSenders: NextAction = { label: 'Fix the senders that fail DMARC', who: WHO.providers, to: `${page}/analytics` };

	if (policy === 'none') {
		const sentence = `Public DNS shows SPF and DMARC at p=none${so} mail that fails DMARC is still delivered.`;
		if (rate !== null && rate >= READY) return { status: 'approval', level, sentence, evidence, checked, next: { label: 'Review your senders, then approve p=quarantine', who: WHO.approver, to: `${page}/dmarc-wizard` } };
		if (rate !== null) return { status: 'improve', level, sentence, evidence, checked, next: fixSenders };
		return {
			status: 'improve',
			level,
			sentence,
			evidence,
			checked,
			next: hasReportAddress(domain.rua_address) ? { label: 'Make sure your DMARC record sends reports here', who: WHO.dns, to: page } : { label: 'Confirm every sending service before moving to p=quarantine', who: WHO.providers, to: page },
		};
	}

	// Enforced: p=quarantine or p=reject.
	const outcome = policy === 'reject' ? 'rejected' : 'quarantined, usually to spam';
	const sentence = `Public DNS shows SPF and DMARC at p=${policy}${so} mail that fails DMARC is ${outcome}.`;
	if (rate !== null && rate < HARMFUL) {
		return { status: 'attention', level, sentence: `${sentence} Only ${rate}% of reported mail passes, so some of your own mail is likely ${policy === 'reject' ? 'rejected' : 'in spam'}.`, evidence, checked, next: fixSenders };
	}
	if (policy === 'quarantine' && rate !== null && rate >= READY_FOR_REJECT) {
		return { status: 'approval', level, sentence, evidence, checked, next: { label: 'Review your senders, then approve p=reject', who: WHO.approver, to: `${page}/dmarc-wizard` } };
	}
	if (rate !== null && rate < READY) return { status: 'improve', level, sentence, evidence, checked, next: fixSenders };
	if (policy === 'quarantine') return { status: 'verified', level, sentence, evidence, checked, next: { label: 'Move to p=reject once reports confirm your senders', who: WHO.you, to: page } };
	return { status: 'verified', level, sentence, evidence, checked, next: NOTHING };
}

/** A domain whose summary could not be loaded: unknown, never a guessed level. */
export function unavailableVerdict(message: string): DomainVerdict {
	return {
		status: 'unknown',
		level: null,
		sentence: `What we know about this domain could not be loaded: ${message}`,
		evidence: null,
		checked: null,
		next: { label: 'Try again', who: WHO.you },
	};
}

/** Sort key: most urgent first, then by name. */
export const byUrgency = <T extends { status: StatusKind; name: string }>(a: T, b: T): number => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name);

const PHRASE: Record<StatusKind, [one: string, many: string]> = {
	attention: ['needs attention', 'need attention'],
	approval: ['is awaiting your approval', 'are awaiting your approval'],
	improve: ['is worth fixing', 'are worth fixing'],
	unknown: ['is unknown', 'are unknown'],
	gathering: ['is still gathering evidence', 'are still gathering evidence'],
	prepared: ['has a change prepared', 'have a change prepared'],
	verified: ['is verified', 'are verified'],
	note: ['has a note', 'have notes'],
};

const list = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * The one-sentence answer to "Am I done?" for the whole workspace. `null` entries are still loading.
 * "Done" only when every domain is Verified, and then it names its scope.
 */
export function workspaceAnswer(rows: Array<{ name: string; verdict: DomainVerdict | null }>, claims = 0): string {
	const n = rows.length;
	const waiting = claims === 1 ? '1 domain is waiting for proof that it is yours' : `${claims} domains are waiting for proof that they are yours`;
	if (n === 0) return claims > 0 ? `Not yet: ${waiting}.` : 'Nothing to check yet: this workspace has no domains.';
	if (claims > 0) return `${workspaceAnswer(rows)} ${waiting.charAt(0).toUpperCase()}${waiting.slice(1)}.`;
	if (rows.some((r) => !r.verdict)) return `Checking where your ${n === 1 ? 'domain stands' : `${n} domains stand`}…`;
	const kinds = rows.map((r) => r.verdict!.status);
	if (kinds.every((k) => k === 'verified' || k === 'note')) {
		const unconfirmed = rows.filter((r) => r.verdict!.evidence && !/% of .* passed/.test(r.verdict!.evidence)).length;
		const scope = unconfirmed === 0 ? 'from public DNS and reports' : 'from public DNS';
		return n === 1 ? `Done, ${scope}: ${rows[0]!.name} is verified.` : `Done, ${scope}: all ${n} domains are verified.`;
	}
	if (n === 1) return `Not yet: ${rows[0]!.name} ${PHRASE[kinds[0]!][0]}.`;
	const counts = STATUS_RANK.map((k) => [k, kinds.filter((x) => x === k).length] as const).filter(([, c]) => c > 0);
	return `Not yet. Of ${n} domains, ${list(counts.map(([k, c]) => `${c} ${PHRASE[k][c === 1 ? 0 : 1]}`))}.`;
}
