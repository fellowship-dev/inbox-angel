import { Badge, Button, Card, CardContent, CheckResult, CheckResultList, LevelCard, Skeleton } from '@inbox-angel/ui';
import { Link } from 'react-router';
import { sumStats, wizardProgress } from '../../lib/dmarc';
import { useCheckSummary, useStats, useWizardState } from '../../lib/domain-queries';
import { formatNumber } from '../../lib/format';
import { errorMessage } from '../../lib/api';
import { assessDomain } from '../../lib/levels';
import type { Domain } from '../../lib/types';

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
				</CardContent>
			</Card>
		);
	}

	const a = assessDomain(summary.data);
	const sums = stats.data ? sumStats(stats.data.stats) : null;
	const progress = wizard.data ? wizardProgress(wizard.data) : null;

	return (
		<LevelCard level={a.level} domain={<DomainLink domain={domain} />} description={a.description} findings={a.findings}>
			<div className="space-y-3 border-t border-line pt-4 text-sm">
				<p className="text-ink-2">
					{stats.isError
						? '7-day results are unavailable right now.'
						: !sums
							? 'Loading 7-day results…'
							: sums.total === 0
								? 'No reports in the last 7 days.'
								: `${sums.passRate}% pass rate over 7 days, ${formatNumber(sums.total)} messages${sums.failed > 0 ? `, ${formatNumber(sums.failed)} failed` : ''}.`}
				</p>
				{a.next ? <p className="text-ink-1">Next: {a.next}</p> : null}
				<div className="flex flex-wrap items-center gap-2">
					{summary.data.dmarc_policy ? <Badge variant="outline">p={summary.data.dmarc_policy}</Badge> : null}
					{/* Protected domains are done: nudging them to finish a wizard would contradict the level above. */}
					{progress && progress.done < progress.total && a.level < 2 ? (
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
