import { statusRank, type StatusKind } from '@inbox-angel/ui';
import { isRevokedDkimKey } from './dkim';
import { enforcementLevel, hasReportAddress, parseDmarcPolicy } from './dmarc-record';
import type { DnsCheck, OnboardingResult } from './domain-queries';
import { formatNumber } from './format';
import { didNotResolve } from './levels';
import type { Domain, DomainCheckSummary, FailingSource } from './types';
import { WHO, type ReportTotals } from './verdict';

/**
 * "Do this next" on a domain page: one to three actions, each as Do this / Why, built from what the page already
 * reads (live DNS, the stored DNS facts, the last 7 days of reports). Every item names who acts and, when there is
 * one, where to do it. A lookup that failed is Unknown, never "not found".
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

	if (summary && didNotResolve(summary) === 'now') {
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

	// DMARC, from the live record; a subdomain covered by its parent's record has none of its own and needs none.
	const live = dns && !dns.error ? dns : null;
	const inherited = summary?.dmarc_inherited_from && summary.dmarc_policy ? summary.dmarc_inherited_from : null;
	const issue = summary && !summary.dmarc_policy ? summary.dmarc_issue : null;
	let policy: string | null = null;
	if (issue === 'multiple') {
		out.push({ key: 'dmarc-multiple', status: 'attention', do: 'Keep one DMARC record and delete the others', why: 'With several DMARC records published, receivers ignore all of them.', who: WHO.dns });
	} else if (issue === 'invalid') {
		out.push({ key: 'dmarc-invalid', status: 'attention', do: 'Fix the DMARC record so it has a valid p= policy', why: 'Without a valid policy, receivers ignore the record.', who: WHO.dns, to: `${page}/setup/4`, cta: 'Open the DMARC step', writes: true });
	} else if (live && !live.found && !inherited) {
		out.push({ key: 'dmarc-missing', status: 'attention', do: 'Publish a DMARC record, starting at p=none', why: `Receivers get no instruction for mail that fails, and nobody sends reports about who mails as ${name}.`, who: WHO.dns, to: `${page}/setup/4`, cta: 'Open the DMARC step', writes: true });
	} else if (live?.found && live.current_record) {
		policy = parseDmarcPolicy(live.current_record);
		if (!live.has_rua && hasReportAddress(domain.rua_address)) {
			out.push({ key: 'dmarc-rua', status: 'improve', do: 'Add the reports address to your DMARC record', why: `Until reports arrive here, nobody can confirm which services send as ${name} and pass.`, who: WHO.dns, to: `${page}/setup/4`, cta: 'Open the DMARC step', writes: true });
		}
	} else if (inherited) {
		policy = summary?.dmarc_policy ?? null;
	}

	// Reports: what the senders do under the current policy.
	if (policy) {
		const has = reports && reports.total > 0 && reports.passRate !== null;
		const rate = has ? reports.passRate! : null;
		const tally = has ? `${rate}% of ${formatNumber(reports.total)} reported messages passed DMARC in the last ${reports.days} days` : '';
		const top = sources?.length ? ` The largest failing source is ${sources[0]!.org ?? sources[0]!.base_domain ?? sources[0]!.source_ip}.` : '';
		const fix = (status: StatusKind, why: string): DomainAction => ({ key: 'senders', status, do: 'Fix the senders that fail DMARC', why, who: WHO.providers, to: `${page}/analytics`, cta: 'See who fails and why' });
		const enforced = enforcementLevel(live?.current_record ?? null);
		if (policy === 'none') {
			if (rate !== null && rate >= 95) out.push({ key: 'approve', status: 'approval', do: 'Approve moving DMARC to p=quarantine', why: `${tally}, so your senders look ready. Today, mail that fails DMARC is still delivered.`, who: WHO.approver, to: `${page}/dmarc-wizard`, cta: 'Review the change', writes: true });
			else if (rate !== null) out.push(fix('improve', `${tally}.${top} Move to quarantine only once they pass.`));
			else if (reports && hasReportAddress(domain.rua_address) && !out.some((a) => a.key === 'dmarc-rua')) out.push({ key: 'gathering', status: 'gathering', do: 'Wait for the first DMARC reports', why: 'Receivers send them about once a day. Until they arrive, nobody can confirm that every sender passes, so p=none stays the safe setting.', who: WHO.nobody });
			else if (reports && !hasReportAddress(domain.rua_address)) out.push({ key: 'no-reports', status: 'unknown', do: 'Confirm every service that sends as you before moving to p=quarantine', why: 'Reports are not connected for this domain, so pass rates are unknown.', who: WHO.providers });
		} else if (policy === 'quarantine' || policy === 'reject') {
			if (rate !== null && rate < 70) out.push(fix('attention', `${tally}, so some of your own mail is likely ${policy === 'reject' ? 'rejected' : 'in spam'}.${top}`));
			else if (policy === 'quarantine' && rate !== null && rate >= 90) out.push({ key: 'approve', status: 'approval', do: 'Approve moving DMARC to p=reject', why: `${tally}. Reject stops spoofed mail outright instead of sending it to spam.`, who: WHO.approver, to: `${page}/dmarc-wizard`, cta: 'Review the change', writes: true });
			else if (rate !== null && rate < 95) out.push(fix('improve', `${tally}.${top}`));
			if (enforced.level === 'partial') out.push({ key: 'pct', status: 'improve', do: `Raise pct from ${enforced.pct} to 100`, why: `Today the policy applies to ${enforced.pct}% of mail that fails; receivers handle the rest one level weaker.`, who: WHO.dns });
		}
	}

	// DKIM: DNS cannot list selectors, so finding none is Unknown, not missing.
	if (onboarding && !errors.some((e) => e.startsWith('dkim'))) {
		const sel = onboarding.dkim.selectors;
		const revoked = sel.filter((s) => isRevokedDkimKey(s.record)).length;
		if (sel.length === 0) out.push({ key: 'dkim-unknown', status: 'unknown', do: 'Ask your email provider which DKIM selector it signs with', why: 'None of the common selectors we check has a key. Your provider may use another one, so this is not proof DKIM is missing.', who: WHO.providers });
		else if (revoked === sel.length) out.push({ key: 'dkim-revoked', status: 'attention', do: 'Publish a working DKIM key from your email provider', why: `Every DKIM key we found has an empty p=, which means it was revoked, so nothing signed with it passes.`, who: WHO.providers });
	}

	const sorted = out.sort((a, b) => statusRank(a.status) - statusRank(b.status)).slice(0, MAX);
	if (sorted.length > 0) return sorted;
	if (dns === undefined || onboarding === undefined) return [];
	const scope = reports && reports.total > 0 ? `public DNS and ${formatNumber(reports.total)} reported messages` : 'public DNS';
	return [{ key: 'done', status: 'verified', do: 'Nothing to do', why: `Nothing in ${scope} needs a change right now.`, who: WHO.nobody }];
}

/** Still reading: the list would change once DNS answers. */
export const actionsPending = (i: Pick<ActionInput, 'dns' | 'onboarding'>) => i.dns === undefined || i.onboarding === undefined;
