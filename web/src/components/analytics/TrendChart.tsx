import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@inbox-angel/ui';
import { useId, useState } from 'react';
import { bucketTrend, fmtPct, type TrendDay } from '../../lib/analytics';
import { formatNumber } from '../../lib/format';
import { Segmented } from '../reports';

const W = 720;
const H = 200;
const PAD = { top: 8, right: 8, bottom: 22, left: 44 };

const niceMax = (n: number): number => {
	if (n <= 0) return 10;
	const pow = 10 ** Math.floor(Math.log10(n));
	return ([1, 2, 5, 10].map((m) => m * pow).find((v) => v >= n) ?? n);
};

/**
 * Stacked daily columns: passed (solid) under failed (hatched), so the split reads without colour.
 * "View as table" swaps in the same numbers as a table. Weekly buckets past 30 days keep 90 days legible.
 */
export function TrendChart({ trend, days }: { trend: TrendDay[]; days: number }) {
	const [view, setView] = useState<'chart' | 'table'>('chart');
	const hatch = useId();
	const points = bucketTrend(trend, days > 30 ? 'week' : 'day');
	const has = points.some((p) => p.total > 0);
	const unit = days > 30 ? 'week' : 'day';

	if (!has) {
		return <EmptyState title="No reports in this window" description="The trend appears once receivers send aggregate reports, usually within a day of publishing your DMARC record." />;
	}

	const max = niceMax(Math.max(...points.map((p) => p.total)));
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;
	const slot = innerW / points.length;
	const bar = Math.max(2, Math.min(24, slot - 2));
	const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
	const ticks = [0, max / 2, max];
	const every = Math.ceil(points.length / 8);
	const summary = `Stacked columns of messages per ${unit}, passed and failed, last ${days} days. Switch to the table for exact numbers.`;

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="flex flex-wrap gap-x-4 text-xs text-ink-2">
					<span className="inline-flex items-center gap-1.5">
						<svg aria-hidden width="12" height="12"><rect width="12" height="12" rx="2" className="fill-success" /></svg> Passed DMARC
					</span>
					<span className="inline-flex items-center gap-1.5">
						<svg aria-hidden width="12" height="12">
							<rect width="12" height="12" rx="2" className="fill-danger" />
							<path d="M0 12 12 0M-3 3 3-3M9 15 15 9" className="stroke-surface-1" strokeWidth="1.5" />
						</svg>
						Failed DMARC (hatched)
					</span>
				</p>
				<Segmented<'chart' | 'table'> label="Trend view" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
			</div>

			{view === 'chart' ? (
				<figure className="m-0">
					<svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-full text-ink-2">
						<defs>
							<pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
								<rect width="6" height="6" className="fill-danger" />
								<rect width="2" height="6" className="fill-surface-1" opacity="0.55" />
							</pattern>
						</defs>
						{ticks.map((t) => (
							<g key={t}>
								<line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth="1" />
								<text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="fill-current text-[10px]">{formatNumber(Math.round(t))}</text>
							</g>
						))}
						{points.map((p, i) => {
							const x = PAD.left + i * slot + (slot - bar) / 2;
							const hp = (p.passed / max) * innerH;
							const hf = (p.failed / max) * innerH;
							return (
								<g key={p.day}>
									<title>{`${p.day}: ${formatNumber(p.total)} messages, ${formatNumber(p.passed)} passed, ${formatNumber(p.failed)} failed`}</title>
									{p.passed > 0 ? <rect x={x} y={y(0) - hp} width={bar} height={hp} className="fill-success" /> : null}
									{p.failed > 0 ? <rect x={x} y={y(0) - hp - hf} width={bar} height={hf} fill={`url(#${hatch})`} /> : null}
									{i % every === 0 ? <text x={x + bar / 2} y={H - 6} textAnchor="middle" className="fill-current text-[10px]">{p.day.slice(5).replace('-', '/')}</text> : null}
								</g>
							);
						})}
					</svg>
					<figcaption className="sr-only">{summary}</figcaption>
				</figure>
			) : (
				<Table label={`Messages per ${unit}`} containerClassName="max-h-80">
						<caption className="sr-only">Messages per {unit}, last {days} days</caption>
						<TableHeader>
							<TableRow>
								<TableHead scope="col">{unit === 'week' ? 'Week of' : 'Day'}</TableHead>
								<TableHead scope="col" className="text-right">Messages</TableHead>
								<TableHead scope="col" className="text-right">Passed</TableHead>
								<TableHead scope="col" className="text-right">Failed</TableHead>
								<TableHead scope="col" className="text-right">Pass rate</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{points.map((p) => (
								<TableRow key={p.day}>
									<TableCell className="font-mono text-xs">{p.day}</TableCell>
									<TableCell className="text-right tabular-nums">{formatNumber(p.total)}</TableCell>
									<TableCell className="text-right tabular-nums">{formatNumber(p.passed)}</TableCell>
									<TableCell className="text-right tabular-nums">{formatNumber(p.failed)}</TableCell>
									<TableCell className="text-right tabular-nums">{p.total > 0 ? fmtPct(Math.round((p.passed / p.total) * 1000) / 10) : 'no reports'}</TableCell>
								</TableRow>
							))}
						</TableBody>
				</Table>
			)}
		</div>
	);
}
