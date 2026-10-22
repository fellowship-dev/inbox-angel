import { EmptyState } from '@inbox-angel/ui';
import { Link } from 'react-router';
import { formatNumber } from '../../lib/format';
import type { DailyStat } from '../../lib/types';

/** One row per day: passed and failed segments scaled to the busiest day (SVG, so no inline styles). Counts are text. */
export function DailyChart({ domainId, stats, days }: { domainId: number; stats: DailyStat[]; days: number }) {
	if (stats.length === 0) {
		return <EmptyState title="No reports in this window" description="Daily bars appear once receivers send their first aggregate reports, usually within a day of publishing your DMARC record." />;
	}
	const max = Math.max(...stats.map((r) => r.total), 1);
	return (
		<div className="space-y-2">
			<p className="flex flex-wrap gap-x-4 text-xs text-ink-2">
				<span className="inline-flex items-center gap-1.5">
					<span aria-hidden className="size-2.5 rounded-sm bg-success" /> Passed
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span aria-hidden className="size-2.5 rounded-sm bg-danger" /> Failed
				</span>
			</p>
			<ul aria-label={`Daily results, last ${days} days`} className="space-y-1">
				{stats.map((row) => {
					const passW = (row.passed / max) * 100;
					const failW = (row.failed / max) * 100;
					return (
						<li key={row.day}>
							<Link to={`/domains/${domainId}/reports/${row.day}`} className="flex items-center gap-3 rounded-md px-1 py-1 hover:bg-surface-2">
								<span className={`shrink-0 font-mono tabular-nums text-ink-2 ${days > 7 ? 'w-12 text-xs' : 'w-14 text-sm'}`}>{days > 7 ? row.day.slice(5).replace('-', '/') : row.day.slice(5)}</span>
								<svg aria-hidden className="h-4 min-w-0 flex-1 rounded bg-surface-2" preserveAspectRatio="none">
									<rect x="0" y="0" height="100%" width={`${passW}%`} className="fill-success" />
									<rect x={`${passW}%`} y="0" height="100%" width={`${failW}%`} className="fill-danger" />
								</svg>
								<span className="shrink-0 text-right text-xs tabular-nums text-ink-2 sm:w-40">
									<span className="font-medium text-ink-1">{formatNumber(row.total)}</span>
									<span className="hidden sm:inline">
										{' '}
										({formatNumber(row.passed)} passed, {formatNumber(row.failed)} failed)
									</span>
									<span className="sr-only sm:hidden">
										{' '}
										({formatNumber(row.passed)} passed, {formatNumber(row.failed)} failed)
									</span>
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
