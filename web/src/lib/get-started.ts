import type { Step } from '../components/GetStarted';
import { hasReportAddress } from './dmarc-record';
import { timeAgo } from './format';
import type { Domain, DomainCheckSummary } from './types';
import type { DomainVerdict, ReportTotals } from './verdict';

export interface GetStartedInput {
	/** Hosted sign-ups prove ownership before a domain is watched; self-host adds it straight away. */
	hosted: boolean;
	domains: Array<Pick<Domain, 'id' | 'domain' | 'rua_address'>>;
	/** Domains waiting for an ownership proof. */
	claims: number;
	/** Per domain, in the same order. Undefined while loading, null when it failed. */
	summaries: Array<DomainCheckSummary | null | undefined>;
	verdicts: Array<DomainVerdict | null>;
	reports: Array<ReportTotals | null | undefined>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The steps to a first answer, each from data. See GetStarted for what the states mean. */
export function getStartedSteps(i: GetStartedInput): Step[] {
	const n = i.domains.length;
	const steps: Step[] = [];

	steps.push(
		n + i.claims > 0
			? { key: 'add', title: 'Add the domain you send email from', state: 'done', detail: i.claims > 0 ? `${plural(n, 'domain')} added, and ${i.claims} waiting for proof of ownership.` : `${plural(n, 'domain')} added.` }
			: {
					key: 'add',
					title: 'Add the domain you send email from',
					state: 'todo',
					detail: 'We read its SPF, DKIM and DMARC from public DNS right away. Adding it changes nothing in its DNS.',
					action: { label: 'Add a domain', to: '/setup' },
				},
	);

	if (i.hosted || i.claims > 0) {
		steps.push(
			i.claims === 0 && n > 0
				? { key: 'prove', title: 'Prove it is yours', state: 'done', detail: 'Ownership is proven for every domain you added.' }
				: { key: 'prove', title: 'Prove it is yours', state: 'todo', detail: i.claims > 0 ? `${plural(i.claims, 'domain is', 'domains are')} waiting for the DNS record shown below. Its live level from public DNS is visible before proof: press Check public DNS on its card.` : 'Once a domain is added, a DNS record proves you own it. Its live level from public DNS is visible before that.' },
		);
	}

	// Read from DNS: the stored check says when, so a page visit alone ticks nothing.
	const loading = i.summaries.some((s) => s === undefined);
	const readAt = i.summaries.map((s) => s?.dns_checked_at ?? (s?.dns_check_status === 'nxdomain' ? s.dns_check_attempted_at : null) ?? null);
	const unread = i.domains.find((_, k) => i.summaries[k] && !readAt[k]);
	const latest = Math.max(0, ...readAt.map((t) => t ?? 0));
	if (n === 0) steps.push({ key: 'read', title: 'See what public DNS shows', state: 'todo', detail: 'Each domain is read from public DNS as soon as it is added.' });
	else if (loading) steps.push({ key: 'read', title: 'See what public DNS shows', state: 'unknown', detail: 'Loading what has been read so far.' });
	else if (latest > 0) steps.push({ key: 'read', title: 'See what public DNS shows', state: 'done', detail: `Last read from public DNS ${timeAgo(latest)}.` });
	else steps.push({ key: 'read', title: 'See what public DNS shows', state: 'todo', detail: unread ? `Open ${unread.domain} to read its records now.` : 'Nothing has been read from DNS yet.', action: unread ? { label: `Open ${unread.domain}`, to: `/domains/${unread.id}` } : undefined });

	// SPF and DMARC published on every domain (level Authenticated or above).
	const known = i.verdicts.filter((v) => v && v.level !== null);
	const authenticated = known.filter((v) => (v!.level ?? 0) >= 1).length;
	// A domain at level 0, or one known to need attention without a level (it does not resolve), still has work to do.
	const firstGap = i.domains.findIndex((_, k) => i.verdicts[k]?.level === 0 || (i.verdicts[k]?.level === null && i.verdicts[k]?.status === 'attention'));
	if (n === 0) steps.push({ key: 'publish', title: 'Publish SPF and DMARC', state: 'todo', detail: 'The domain page shows the exact records to copy.' });
	else if (authenticated === n) steps.push({ key: 'publish', title: 'Publish SPF and DMARC', state: 'done', detail: n === 1 ? 'Your domain publishes both.' : `All ${n} domains publish both.` });
	else if (known.length < n && firstGap < 0) steps.push({ key: 'publish', title: 'Publish SPF and DMARC', state: 'unknown', detail: `${authenticated} of ${n} confirmed so far. The rest have not been read from DNS yet.` });
	else {
		const gap = i.domains[firstGap];
		const v = i.verdicts[firstGap];
		steps.push({ key: 'publish', title: 'Publish SPF and DMARC', state: 'todo', detail: `${authenticated} of ${plural(n, 'domain')} publish both.`, action: gap && v?.next.to ? { label: `Fix ${gap.domain}`, to: v.next.to } : undefined });
	}

	// Reports: only where they can arrive (a reports address is configured for at least one domain).
	if (i.domains.some((d) => hasReportAddress(d.rua_address))) {
		const any = i.reports.some((r) => r && r.total > 0);
		const reportsLoading = i.reports.some((r) => r === undefined);
		steps.push(
			any
				? { key: 'reports', title: 'Receive DMARC reports', state: 'done', detail: 'Reports are arriving, so pass rates are measured, not assumed.' }
				: reportsLoading
					? { key: 'reports', title: 'Receive DMARC reports', state: 'unknown', detail: 'Loading report totals.' }
					: { key: 'reports', title: 'Receive DMARC reports', state: 'waiting', detail: 'None yet. Receivers send them about once a day after a DMARC record names the reports address.' },
		);
	}
	return steps;
}
