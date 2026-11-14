import { statusRank, type StatusKind } from '@ready-set-mail/ui';
import { isRevokedDkimKey, isUsableDkimSelector } from './dkim';
import { dkimWildcardSummary } from './dkim-wildcard';
import { dmarcCoverage, inheritedSentence, keptEnforcement, offerEnforcement } from './dmarc-coverage';
import { enforcementLevel, hasReportAddress, parseDmarcPolicy, weakerSubdomainPolicy } from './dmarc-record';
import type { DnsCheck, OnboardingResult } from './domain-queries';
import { formatNumber } from './format';
import { didNotResolve } from './levels';
import type { Domain, DomainCheckSummary, FailingSource } from './types';
import { WHO, exactRate, type ReportTotals } from './verdict';

/**
 * "Do this next" on a domain page: one to three actions, each as Do this / Why, built from what the page already
 * reads (live DNS, the stored DNS facts, the last 7 days of reports). Every item names who acts and, when there is
 * one, where to do it. A lookup that failed is Unknown, never "not found", and no record is offered for a name unless
 * DNS has shown the record is absent.
 */
export interface DomainAction {
	key: string;
	status: StatusKind;
	/** The change, as a verb. */
	do: string;
	/** What it gets you, and the main uncertainty. */
	why: string;
	who: string;
	to?: string;
	/** Link text for `to`. */
	cta?: string;
	/** True when the action changes something in the dashboard (wizards): read-only members are not sent there. */
	writes?: boolean;
	/** For lookups that failed: run them again. */
	retry?: boolean;
}

export interface ActionInput {
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address'>;
	/** Undefined while loading, null when the request failed. */
	dns: DnsCheck | null | undefined;
	onboarding: OnboardingResult | null | undefined;
	summary: DomainCheckSummary | null | undefined;
	/** Totals for the last `days` days of reports. Undefined while loading, null when it failed. */
	reports: ReportTotals | null | undefined;
	sources?: FailingSource[] | null;
}

const MAX = 3;
const SPF_LIMIT = 10;

export function domainActions(input: ActionInput): DomainAction[] {
	const { domain, dns, onboarding, summary, reports, sources } = input;
	const name = domain.domain;
	const page = `/domains/${domain.id}`;
	const out: DomainAction[] = [];

	if (onboarding?.nxdomain || (summary && didNotResolve(summary) === 'now')) {
		return [{ key: 'nxdomain', status: 'attention', do: 'Check the spelling, or remove this domain', why: `DNS says ${name} does not exist, so there are no SPF, DKIM or DMARC records to check.`, who: WHO.you, to: `${page}/settings`, cta: 'Open the domain settings', writes: true }];
	}

	const errors = onboarding?.dns_errors ?? [];
	const dnsFailed = dns === null || !!dns?.error;
	const spfFailed = onboarding === null || errors.some((e) => e.startsWith('spf:'));
	if (dnsFailed || spfFailed) {
		const what = [dnsFailed ? 'DMARC' : null, spfFailed ? 'SPF' : null].filter(Boolean).join(' and ');
		out.push({ key: 'lookup', status: 'unknown', do: `Check ${what} again in a few minutes`, why: `The ${what} lookup did not complete, so we cannot tell whether the record exists. Nothing is assumed missing.`, who: WHO.you, retry: true });
	}

	// SPF
	if (onboarding && !spfFailed) {
		const spf = onboarding.spf;
		if (!spf.record) {
			out.push({ key: 'spf-missing', status: 'attention', do: 'Publish an SPF record that lists the services that send your mail', why: `Without it, receivers cannot tell which servers may send as ${name}.`, who: WHO.dns, to: `${page}/setup/2`, cta: 'Open the SPF step', writes: true });
		} else if (spf.lookup_count !== null && spf.lookup_count > SPF_LIMIT) {
			out.push({ key: 'spf-lookups', status: 'attention', do: `Bring SPF down to ${SPF_LIMIT} DNS lookups or fewer`, why: `It needs ${spf.lookup_count}. Past ${SPF_LIMIT}, receivers treat SPF as an error, so it stops vouching for your mail.`, who: WHO.dns, to: `${page}/spf-flatten`, cta: 'Open SPF flattening', writes: true });
		}
	}

	// DMARC. What covers this name comes from the live read (PR 142's dmarcCoverage: own record, inherited, none, or
	// unknown). A record is offered only at exactly the enforcement in force (offerEnforcement): never weaker, never
	// stricter, and nothing at all while coverage is unknown.
	const dmarcFailed = dnsFailed || errors.some((e) => e.startsWith('dmarc:'));
	const cov = onboarding === undefined ? null : dmarcCoverage(onboarding, dmarcFailed);
	let policy: string | null = null;
	let ownRecord: string | null = null;
	const issue = summary && !summary.dmarc_policy ? summary.dmarc_issue : null;
	if (cov?.kind === 'own' && issue === 'multiple') {
		out.push({ key: 'dmarc-multiple', status: 'attention', do: 'Keep one DMARC record and delete the others', why: 'With several DMARC records published, receivers ignore all of them.', who: WHO.dns });
	} else if (cov?.kind === 'own' && issue === 'invalid' && !(dns?.current_record && parseDmarcPolicy(dns.current_record))) {
		out.push({ key: 'dmarc-invalid', status: 'attention', do: 'Fix the DMARC record so it has a valid p= policy', why: 'Without a valid policy, receivers ignore the record.', who: WHO.dns, to: `${page}/setup/4`, cta: 'Open the DMARC step', writes: true });
	} else if (cov?.kind === 'none') {
		const e = offerEnforcement(cov)!;
		out.push({ key: 'dmarc-missing', status: 'attention', do: `Publish a DMARC record, starting at ${keptEnforcement(cov, e)}`, why: `Neither ${name} nor a parent domain publishes a DMARC record, so receivers get no instruction for mail that fails, and nobody sends reports about who mails as ${name}.`, who: WHO.dns, to: `${page}/setup/4`, cta: 'Open the DMARC step', writes: true });
	} else if (cov?.kind === 'unknown' && !dnsFailed) {
		out.push({
			key: 'dmarc-coverage',
			status: 'unknown',
			do: `Check again whether a parent domain's DMARC record covers ${name}`,
			why: `There is no DMARC record at _dmarc.${name} that we could confirm, and whether a parent domain's record covers it is not known. Nothing is suggested until it is.`,
			who: WHO.you,
			retry: true,
		});
	} else if (cov?.kind === 'inherited') {
		if (!cov.policy) {
			out.push({ key: 'dmarc-parent', status: 'attention', do: `Fix the DMARC record at _dmarc.${cov.parent}`, why: inheritedSentence(name, cov), who: WHO.dns });
		} else {
			policy = cov.policy;
			if (cov.pct < 100 && cov.policy !== 'none') out.push({ key: 'pct', status: 'improve', do: `Raise pct from ${cov.pct} to 100 at _dmarc.${cov.parent}`, why: inheritedSentence(name, cov), who: WHO.dns });
		}
	} else if (cov?.kind === 'own' && dns?.found && dns.current_record) {
		policy = parseDmarcPolicy(dns.current_record);
		ownRecord = dns.current_record;
		if (!dns.has_rua && hasReportAddress(domain.rua_address)) {
			// Under enforcement this changes evidence, not protection: a Note, so the page agrees with the overview's Verified.
			const enforcedNow = policy === 'quarantine' || policy === 'reject';
			out.push({ key: 'dmarc-rua', status: enforcedNow ? 'note' : 'improve', do: 'Add the reports address to your DMARC record', why: `Until reports arrive here, nobody can confirm which services send as ${name} and pass.`, who: WHO.dns, to: `${page}/setup/4`, cta: 'Open the DMARC step', writes: true });
		}
	}

	// Reports: what the senders do under the current policy. p=none is never "nothing to do".
	const rate = exactRate(reports);
	const shown = reports && reports.total > 0 ? `${reports.passRate}% of ${formatNumber(reports.total)} reported messages passed DMARC in the last ${reports.days} days` : '';
	const top = sources?.length ? ` The largest failing source is ${sources[0]!.org ?? sources[0]!.base_domain ?? sources[0]!.source_ip}.` : '';
	const fix = (status: StatusKind, why: string): DomainAction => ({ key: 'senders', status, do: 'Fix the senders that fail DMARC', why, who: WHO.providers, to: `${page}/analytics`, cta: 'See who fails and why' });
	const reloadReports = (why: string): DomainAction => ({ key: 'reports-failed', status: 'unknown', do: 'Load the report totals again', why, who: WHO.you, retry: true });
	if (policy === 'none') {
		if (rate !== null && rate >= 95) out.push({ key: 'approve', status: 'approval', do: 'Approve moving DMARC to p=quarantine', why: `${shown}, so your senders look ready. Today, mail that fails DMARC is still delivered.`, who: WHO.approver, to: `${page}/dmarc-wizard`, cta: 'Review the change', writes: true });
		else if (rate !== null) out.push(fix('improve', `${shown}.${top} Move to quarantine only once they pass.`));
		else if (reports === null) out.push(reloadReports('They could not be loaded, so whether every sender passes is unknown. Under p=none, mail that fails DMARC is still delivered.'));
		else if (reports && hasReportAddress(domain.rua_address) && !out.some((a) => a.key === 'dmarc-rua')) out.push({ key: 'gathering', status: 'gathering', do: 'Wait for the first DMARC reports', why: 'Receivers send them about once a day. Until they arrive, nobody can confirm that every sender passes, so p=none stays the safe setting.', who: WHO.nobody });
		else if (reports && !hasReportAddress(domain.rua_address)) out.push({ key: 'no-reports', status: 'unknown', do: 'Confirm every service that sends as you before moving to p=quarantine', why: 'Reports are not connected for this domain, so pass rates are unknown. Under p=none, mail that fails DMARC is still delivered.', who: WHO.providers });
	} else if (policy === 'quarantine' || policy === 'reject') {
		if (rate !== null && rate < 70) out.push(fix('attention', `${shown}, so some of your own mail is likely ${policy === 'reject' ? 'rejected' : 'in spam'}.${top}`));
		else if (policy === 'quarantine' && rate !== null && rate >= 90) out.push({ key: 'approve', status: 'approval', do: 'Approve moving DMARC to p=reject', why: `${shown}. Reject stops spoofed mail outright instead of sending it to spam.`, who: WHO.approver, to: `${page}/dmarc-wizard`, cta: 'Review the change', writes: true });
		else if (rate !== null && rate < 95) out.push(fix('improve', `${shown}.${top}`));
		else if (reports === null) out.push(reloadReports('They could not be loaded, so whether every sender passes is unknown.'));
		if (ownRecord) {
			const enforced = enforcementLevel(ownRecord);
			if (enforced.level === 'partial') out.push({ key: 'pct', status: 'improve', do: `Raise pct from ${enforced.pct} to 100`, why: `Today the policy applies to ${enforced.pct}% of mail that fails; receivers handle the rest one level weaker.`, who: WHO.dns });
			const weak = weakerSubdomainPolicy(ownRecord);
			if (weak) out.push({ key: 'sp', status: 'improve', do: `Set sp=${policy} to enforce subdomains too`, why: `Mail that fails DMARC from ${name} itself is ${policy === 'reject' ? 'rejected' : 'quarantined'}, but subdomains without their own record follow sp=${weak}, so failing mail from them is ${weak === 'none' ? 'still delivered' : 'quarantined, not rejected'}.`, who: WHO.dns });
		}
	}

	// DKIM. DNS cannot list selectors: none found, or a wildcard answer, is Unknown, never missing. Revoked old keys next
	// to a working one are a Note; they need attention only when no usable key exists.
	if (onboarding && !errors.some((e) => e.startsWith('dkim'))) {
		const { selectors, wildcard } = onboarding.dkim;
		const revoked = selectors.filter((s) => isRevokedDkimKey(s.record)).length;
		const usable = selectors.filter((s) => !isRevokedDkimKey(s.record) && isUsableDkimSelector(s.record)).length;
		if (wildcard) out.push({ key: 'dkim-wildcard', status: 'unknown', do: 'Ask your email provider which DKIM selector it signs with', why: `${dkimWildcardSummary(name)} Can't tell from public DNS whether DKIM is set up.`, who: WHO.providers });
		else if (selectors.length === 0) out.push({ key: 'dkim-unknown', status: 'unknown', do: 'Ask your email provider which DKIM selector it signs with', why: 'None of the common selectors we check has a key. Your provider may use another one, so this is not proof DKIM is missing.', who: WHO.providers });
		else if (usable === 0 && revoked > 0) out.push({ key: 'dkim-revoked', status: 'attention', do: 'Publish a working DKIM key from your email provider', why: 'Every DKIM key we found has an empty p=, which means it was revoked, so nothing signed with it passes.', who: WHO.providers });
		else if (usable > 0 && revoked > 0) out.push({ key: 'dkim-old', status: 'note', do: `${revoked} old DKIM ${revoked === 1 ? 'key is' : 'keys are'} revoked`, why: `${usable} other ${usable === 1 ? 'key works' : 'keys work'}, so nothing breaks. Remove the revoked ones when convenient.`, who: WHO.nobody });
	}

	// Order by consequence. When reports show mail passing, a DKIM selector DNS cannot find is not a problem in practice.
	if (rate !== null && rate >= 95) for (const a of out) if (a.key === 'dkim-unknown' || a.key === 'dkim-wildcard') a.status = 'note';
	const sorted = out.sort((a, b) => statusRank(a.status) - statusRank(b.status));
	const pending = dns === undefined || onboarding === undefined || reports === undefined;
	const blocking = sorted.filter((a) => a.status !== 'note');
	if (blocking.length > 0) return sorted.slice(0, MAX);
	if (pending) return [];
	// Nothing to do only with every fact known: coverage settled, reports loaded, policy enforced.
	const scope = reports && reports.total > 0 ? `public DNS and ${formatNumber(reports.total)} reported messages` : 'public DNS';
	return [{ key: 'done', status: 'verified', do: 'Nothing to do', why: `Nothing in ${scope} needs a change right now.`, who: WHO.nobody } as DomainAction, ...sorted].slice(0, MAX);
}

/** Still reading: the list would change once DNS, onboarding or the report totals answer. */
export const actionsPending = (i: Pick<ActionInput, 'dns' | 'onboarding' | 'reports'>) => i.dns === undefined || i.onboarding === undefined || i.reports === undefined;
