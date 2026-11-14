import type { Finding, Level } from '@inbox-angel/ui';
import { formatPercent, timeAgo } from './format';
import type { DomainCheckSummary } from './types';

/**
 * Where a domain stands, from what InboxAngel already knows (domain row + check summary).
 *
 *  - Level 0 Delivering:    mail goes out, but SPF or DMARC is missing, so receivers cannot verify it.
 *  - Level 1 Authenticated: SPF and a DMARC record exist; DMARC only monitors (p=none).
 *  - Level 2 Protected:     DMARC enforces (p=quarantine or p=reject) on top of SPF.
 *
 * The stored SPF record and DMARC policy are null until DNS has been read (`dns_checked_at`), so for a self-managed domain
 * null before that means "not checked yet", never "not found": it is shown as a neutral unknown and the level counts only
 * what is confirmed. Once both were read, null is DNS's answer that there is no record. A lookup that failed never reaches this function: callers show an error state instead of a level.
 * The stored DMARC policy is the effective one: a subdomain with no record of its own carries its parent's (`sp=`, else `p=`),
 * and `dmarc_inherited_from` names the parent. `dmarc_issue` says a record exists but gives no policy (several, or invalid).
 * Hosted domains pass `nullMeans: 'missing'`, because there null means the record is not live in our zone.
 */
export interface LevelAssessment {
	level: Level;
	description: string;
	findings: Finding[];
	/** One sentence on the next step, or null at the top level. */
	next: string | null;
}

const DKIM_HEALTHY = 0.95;

const NOT_CHECKED_DETAIL = 'The overview has no stored result for this yet. The domain page reads it live from DNS.';

type DnsFacts = Partial<Pick<DomainCheckSummary, 'dns_checked_at' | 'dmarc_issue' | 'dmarc_inherited_from'>>;

export function assessDomain(
	s: Pick<DomainCheckSummary, 'dmarc_policy' | 'spf_record' | 'dkim_total' | 'dkim_pass' | 'spf_total' | 'spf_pass' | 'mta_sts_enabled' | 'mta_sts_mode'> & DnsFacts,
	{ nullMeans = s.dns_checked_at ? 'missing' : 'unknown', reports = true }: { nullMeans?: 'unknown' | 'missing'; /** false: report intake is not connected (hosted), so no advice may lean on reports. */ reports?: boolean } = {},
): LevelAssessment {
	const hasSpf = !!s.spf_record;
	const policy = s.dmarc_policy;
	const enforcing = policy === 'quarantine' || policy === 'reject';
	const spfUnknown = !hasSpf && nullMeans === 'unknown';
	const issue = policy ? null : (s.dmarc_issue ?? null); // a stored policy always wins over a stale issue
	const dmarcUnknown = !policy && !issue && nullMeans === 'unknown';
	const from = s.dmarc_inherited_from ? `, inherited from ${s.dmarc_inherited_from}` : '';

	let level: Level = 0;
	if (hasSpf && policy) level = 1;
	if (hasSpf && enforcing) level = 2;

	const findings: Finding[] = [];
	if (hasSpf) findings.push({ status: 'pass', label: 'SPF record published' });
	else if (spfUnknown) findings.push({ status: 'unknown', label: 'SPF not checked yet', detail: NOT_CHECKED_DETAIL });
	else findings.push({ status: 'missing', label: 'SPF record', detail: 'No SPF record found. Receivers cannot tell which servers may send for you.' });

	if (dmarcUnknown) findings.push({ status: 'unknown', label: 'DMARC not checked yet', detail: NOT_CHECKED_DETAIL });
	else if (issue === 'multiple') findings.push({ status: 'warn', label: 'Multiple DMARC records: receivers ignore them', detail: `Keep one DMARC record at _dmarc.${s.dmarc_inherited_from ?? 'your domain'} and delete the others.` });
	else if (issue === 'invalid') findings.push({ status: 'warn', label: 'DMARC record is invalid', detail: `It has no valid p= policy, so receivers ignore it. Fix the record at _dmarc.${s.dmarc_inherited_from ?? 'your domain'}.` });
	else if (!policy) findings.push({ status: 'missing', label: 'DMARC record', detail: 'No DMARC record found.' });
	else if (enforcing) findings.push({ status: 'pass', label: `DMARC enforced (p=${policy})${from}` });
	else findings.push({ status: 'warn', label: `DMARC is monitoring only (p=none)${from}`, detail: reports
				? 'Failing mail is still delivered. Move to quarantine, then reject, when reports look clean.'
				: 'Failing mail is still delivered. Reports are not connected, so it cannot be confirmed here that every service sending as this domain passes; check that before you move to quarantine.' });

	if (s.dkim_total > 0) {
		const ok = s.dkim_pass / s.dkim_total >= DKIM_HEALTHY;
		findings.push({ status: ok ? 'pass' : 'warn', label: `DKIM passing on ${formatPercent(s.dkim_pass, s.dkim_total)} of reported mail` });
	}
	if (s.mta_sts_enabled) findings.push({ status: 'pass', label: `MTA-STS ${s.mta_sts_mode ?? 'enabled'}` });

	const unchecked = spfUnknown || dmarcUnknown;
	const description = unchecked
		? 'This level counts only what has been checked. Open the domain to see its records in DNS.'
		: ([
				'Mail is being sent, but receivers cannot fully verify it yet.',
				'Receivers can verify your mail. DMARC is not blocking spoofed messages yet.',
				'Spoofed mail from your domain is quarantined or rejected.',
			][level] as string);

	let next: string | null = null;
	if (unchecked) next = 'Open the domain to check its SPF and DMARC records in DNS.';
	else if (!hasSpf) next = 'Publish an SPF record.';
	else if (issue === 'multiple') next = 'Remove the extra DMARC records so only one remains.';
	else if (issue === 'invalid') next = 'Fix the DMARC record so it has a valid p= policy.';
	else if (!policy) next = reports ? 'Publish a DMARC record with p=none to start receiving reports.' : 'Publish a DMARC record with p=none.';
	else if (!enforcing) next = reports ? 'Review your reports, then move DMARC to quarantine.' : 'Confirm every service that sends as this domain passes SPF or DKIM, then move DMARC to quarantine.';

	return { level, description, findings, next };
}

/** When DNS was last read for this domain, and whether the latest attempt failed. */
export function dnsCheckLine(s: Pick<DomainCheckSummary, 'dns_checked_at' | 'dns_check_attempted_at' | 'dns_check_status'> & Partial<Pick<DomainCheckSummary, 'dns_last_good_status'>>): string {
	const goodWhen = s.dns_checked_at ? timeAgo(s.dns_checked_at) : null;
	const good = goodWhen ? `Last good check ${goodWhen}.` : 'No successful check yet.';
	if (s.dns_check_status === 'failed') {
		const failed = `Last check failed${s.dns_check_attempted_at ? ` ${timeAgo(s.dns_check_attempted_at)}` : ''}.`;
		if (goodWhen && s.dns_last_good_status === 'nxdomain') return `${failed} At the last good check (${goodWhen}) this domain did not resolve.`;
		return `${failed} ${good}`;
	}
	return s.dns_checked_at ? `Checked ${timeAgo(s.dns_checked_at)}` : 'Not checked yet';
}

/** The slice of the hosted status that levels need. */
export interface HostedLevelInput {
	mta_sts: boolean;
	pointer_status: { dmarc: string | null; spf: string | null; mta_sts: string | null };
	level_inputs: { dmarc_published: boolean; spf_published: boolean; mta_sts_published: boolean };
}
type LevelSummary = Parameters<typeof assessDomain>[0];

/** A hosted record only counts once its pointer in the customer's DNS is verified. */
const hostedLive = (published: boolean, pointer: string | null) => published && pointer === 'ok';

/**
 * For a hosted domain the stored summary is not the truth (the records live in our zone): SPF, DMARC and MTA-STS
 * "published" come from `level_inputs`, and only when the customer's pointer is verified `ok`.
 * Returns the summary to assess and the purposes whose pointer is not verified yet.
 */
export function applyHostedInputs<S extends LevelSummary>(s: S, h: HostedLevelInput): { summary: S; unverified: Array<'spf' | 'dmarc' | 'mta_sts'> } {
	const spf = hostedLive(h.level_inputs.spf_published, h.pointer_status.spf);
	const dmarc = hostedLive(h.level_inputs.dmarc_published, h.pointer_status.dmarc);
	const mta = hostedLive(h.level_inputs.mta_sts_published, h.pointer_status.mta_sts);
	const unverified: Array<'spf' | 'dmarc' | 'mta_sts'> = [];
	if (!spf) unverified.push('spf');
	if (!dmarc) unverified.push('dmarc');
	if (h.mta_sts && !mta) unverified.push('mta_sts');
	return {
		summary: {
			...s,
			spf_record: spf ? (s.spf_record ?? 'hosted') : null,
			dmarc_policy: dmarc ? (s.dmarc_policy ?? 'none') : null,
			dmarc_issue: null, // stored DNS facts do not describe records in our zone
			dmarc_inherited_from: null,
			mta_sts_enabled: mta ? 1 : 0,
			mta_sts_mode: mta ? s.mta_sts_mode : null,
		},
		unverified,
	};
}

const HOSTED_NAME = { spf: 'SPF', dmarc: 'DMARC', mta_sts: 'MTA-STS' } as const;

/** assessDomain for a hosted domain: levels from `level_inputs`, plus a finding for each pointer not verified yet. */
export function assessHostedDomain(s: LevelSummary, h: HostedLevelInput): LevelAssessment {
	const { summary, unverified } = applyHostedInputs(s, h);
	const a = assessDomain(summary, { nullMeans: 'missing' });
	const extra: Finding[] = unverified.map((p) => ({
		status: 'warn',
		label: `${HOSTED_NAME[p]} pointer not verified yet`,
		detail: h.pointer_status[p] === 'error' ? 'The last DNS lookup failed, so this is not counted as published.' : 'Add the pointer record to your DNS. It counts as published once we can see it.',
	}));
	return { ...a, findings: [...a.findings, ...extra] };
}

/** The last good check found the domain does not exist: now (the latest check agrees) or earlier (the latest attempt failed). */
export const didNotResolve = (s: Pick<DomainCheckSummary, 'dns_check_status' | 'dns_last_good_status'>): 'now' | 'at-last-good-check' | null =>
	s.dns_check_status === 'nxdomain' ? 'now' : s.dns_check_status === 'failed' && s.dns_last_good_status === 'nxdomain' ? 'at-last-good-check' : null;
