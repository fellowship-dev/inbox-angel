import { Badge, Button, Card, CardContent, CheckResult, CheckResultList, LevelCard, Skeleton } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { sumStats, wizardProgress } from '../../lib/dmarc';
import { useCheckSummary, useStats, useWizardState } from '../../lib/domain-queries';
import { formatNumber } from '../../lib/format';
import { errorMessage } from '../../lib/api';
import { useHostedInfo } from '../../lib/hosted';
import { assessDomain, assessHostedDomain, didNotResolve, dnsCheckLine } from '../../lib/levels';
import { useHosted, useSession } from '../../lib/session';
import type { Domain } from '../../lib/types';
import { useReportsNotConnected } from '../ReportsNotConnected';
import { HELP_PRIORITY, TalkToMax } from '../TalkToMax';

function DomainLink({ domain }: { domain: Domain }) {
	return (
		<Link to={`/domains/${domain.id}`} className="underline-offset-4 hover:underline">
			{domain.domain}
		</Link>
	);
}

/** One domain on the overview: its level from the check summary, or an error in place of a level. */
export function DomainLevelCard({ domain }: { domain: Domain }) {
	const summary = useCheckSummary(domain.id);
	const stats = useStats(domain.id, 7);
	const wizard = useWizardState(domain.id);
	const hosted = useHostedInfo(domain.id); // null unless hosted is on for the deployment and this domain
	const { canWrite } = useSession(); // read-only members cannot run the setup wizard, so they are not invited to
	const hostedMode = useHosted();
	const reportsOff = useReportsNotConnected(domain); // hosted, before report intake: no 7-day results can exist

	if (summary.isPending) {
		return (
			<Card aria-busy="true" role="group" aria-label={`${domain.domain}, loading`}>
				<CardContent className="space-y-3">
					<p className="font-mono text-sm text-ink-2">{domain.domain}</p>
					<Skeleton className="h-7 w-1/2" />
					<Skeleton className="h-2 w-full" />
					<Skeleton className="h-16 w-full" />
				</CardContent>
			</Card>
		);
	}

	if (summary.isError) {
		return (
			<Card role="group" aria-label={domain.domain}>
				<CardContent className="space-y-3">
					<h2 className="break-all font-mono text-base font-semibold">
						<DomainLink domain={domain} />
					</h2>
					<CheckResultList>
						<CheckResult
							status="error"
							statusLabel="Could not load"
							title="Protection level"
							summary={`${errorMessage(summary.error)} No level is shown, because we do not want to guess.`}
							onRetry={() => void summary.refetch()}
						/>
					</CheckResultList>
					<TalkToMax priority={HELP_PRIORITY.loadError} lead="Still failing after a retry?" about={`about ${domain.domain}`} />
				</CardContent>
			</Card>
		);
	}

	// DNS says the name does not exist: there is no level to show, and "Delivering" would claim mail is flowing.
	const unresolved = hosted ? null : didNotResolve(summary.data);
	if (unresolved) {
		return (
			<Card role="group" aria-label={domain.domain}>
				<CardContent className="space-y-3">
					<h2 className="break-all font-mono text-base font-semibold">
						<DomainLink domain={domain} />
					</h2>
					<CheckResultList>
						<CheckResult status="missing" statusLabel="Does not resolve" title="This domain does not resolve" summary={unresolved === 'now'
								? 'DNS says this name does not exist, so there are no SPF or DMARC records to check. Check the spelling, or register the domain.'
								: 'At the last good check DNS said this name does not exist, so there were no SPF or DMARC records to show. The latest check got no answer, so this may have changed.'} />
					</CheckResultList>
					<p className="text-sm text-ink-2">{dnsCheckLine(summary.data)}</p>
					<TalkToMax priority={HELP_PRIORITY.dnsFailing} lead="Sure this is the right name?" about={`about ${domain.domain}`} />
				</CardContent>
			</Card>
		);
	}

	const a = hosted ? assessHostedDomain(summary.data, hosted) : assessDomain(summary.data, { reports: !reportsOff });
	const sums = stats.data ? sumStats(stats.data.stats) : null;
	const progress = wizard.data ? wizardProgress(wizard.data, { hosted: hostedMode }) : null;

	return (
		<LevelCard level={a.level} domain={<DomainLink domain={domain} />} description={a.description} findings={a.findings}>
			<div className="space-y-3 border-t border-line pt-4 text-sm">
				{/* Hosted, before report intake: the overview says once, above the cards, that reports are not connected. */}
				{reportsOff ? null : (
					<p className="text-ink-2">
						{stats.isError
							? '7-day results are unavailable right now.'
							: !sums
								? 'Loading 7-day results…'
								: sums.total === 0
									? 'No reports in the last 7 days.'
									: `${sums.passRate}% pass rate over 7 days, ${formatNumber(sums.total)} messages${sums.failed > 0 ? `, ${formatNumber(sums.failed)} failed` : ''}.`}
					</p>
				)}
				{/* The hosted level comes from pointer checks, not from these stored records, so only self-managed cards say when. */}
				{hosted ? null : (
					<p className="text-ink-2">{dnsCheckLine(summary.data)}</p>
				)}
				{!hosted && summary.data.dns_check_status === 'failed' ? <TalkToMax priority={HELP_PRIORITY.dnsFailing} lead="DNS checks keep failing?" about={`about ${domain.domain}`} /> : null}
				{a.next ? <p className="text-ink-1">Next: {a.next}</p> : null}
				<div className="flex flex-wrap items-center gap-2">
					{summary.data.dmarc_policy ? <Badge variant="outline">p={summary.data.dmarc_policy}</Badge> : null}
					{/* Protected domains are done: nudging them to finish a wizard would contradict the level above. */}
					{canWrite && progress && progress.done < progress.total && a.level < 2 ? (
						<Link to={`/domains/${domain.id}/setup/${progress.nextStep}`} className="text-brand-ink underline underline-offset-4">
							Continue setup ({progress.done}/{progress.total})
						</Link>
					) : null}
					<Button asChild variant="secondary" size="sm" className="ml-auto">
						<Link to={`/domains/${domain.id}`}>
							View <span className="sr-only">{domain.domain}</span>
						</Link>
					</Button>
				</div>
			</div>
		</LevelCard>
	);
}
