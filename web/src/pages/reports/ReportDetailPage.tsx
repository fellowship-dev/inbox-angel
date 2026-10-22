import { Card, EmptyState, PageHeader, Stat, StatGroup, cn } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, FileText, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { AuthBadge, BackLink, ProviderName, useRouteDomainId } from '../../components/reports';
import { LoadError, PageSkeleton, Section } from '../../components/states';
import { api } from '../../lib/api';
import { useDomain } from '../../lib/queries';
import { explain, formatDayWithRelative, isFailing, passRate } from '../../lib/reports';
import type { DayReport, ReportSource } from '../../lib/types';

const sourceKey = (s: ReportSource) => `${s.source_ip}-${s.header_from}-${s.spf_domain}-${s.dkim_domain}`;

function FailingCard({ src }: { src: ReportSource }) {
	return (
		<Card className="space-y-3 border-danger/40 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-0.5">
					<ProviderName src={src} />
					{src.header_from ? <span className="block text-xs text-ink-2">sending as {src.header_from}</span> : null}
				</div>
				<p className="shrink-0 text-right">
					<span className="text-xl font-bold tabular-nums text-ink-1">{src.count.toLocaleString()}</span>
					<span className="ml-1 text-xs text-ink-2">{src.count === 1 ? 'message' : 'messages'}</span>
				</p>
			</div>
			<p className="text-sm leading-relaxed text-ink-1">{explain(src)}</p>
			<div className="flex flex-wrap items-center gap-2">
				<AuthBadge protocol="SPF" pass={!!src.spf_pass} />
				<AuthBadge protocol="DKIM" pass={!!src.dkim_pass} />
				{src.reporters ? <span className="text-xs text-ink-2 sm:ml-auto">Reported by {src.reporters}</span> : null}
			</div>
		</Card>
	);
}

function PassingRow({ src }: { src: ReportSource }) {
	const [open, setOpen] = useState(false);
	const panelId = `passing-${sourceKey(src).replace(/[^a-z0-9]/gi, '-')}`;
	const details: Array<[string, string | number | null, boolean]> = [
		['SPF domain', src.spf_domain, true],
		['DKIM domain', src.dkim_domain, true],
		['Sending as', src.header_from, true],
		['Messages', src.count.toLocaleString(), false],
		['Reported by', src.reporters || null, false],
	];
	return (
		<li className="border-b border-line last:border-0">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60"
			>
				<CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
				<span className="sr-only">Passing: </span>
				<span className="min-w-0 flex-1">
					<ProviderName src={src} />
				</span>
				<span className="shrink-0 text-sm tabular-nums text-ink-2">{src.count.toLocaleString()} msg</span>
				<ChevronDown aria-hidden className={cn('size-4 shrink-0 text-ink-2 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
				<span className="sr-only">{open ? 'Hide details' : 'Show details'}</span>
			</button>
			{open ? (
				<div id={panelId} className="space-y-3 bg-surface-2 px-4 py-3">
					<div className="flex flex-wrap gap-2">
						<AuthBadge protocol="SPF" pass={!!src.spf_pass} />
						<AuthBadge protocol="DKIM" pass={!!src.dkim_pass} />
					</div>
					<dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
						{details.map(([label, value, mono]) =>
							value ? (
								<div key={label} className="contents">
									<dt className="text-xs font-semibold uppercase tracking-wide text-ink-2">{label}</dt>
									<dd className={cn('min-w-0 text-ink-1 [overflow-wrap:anywhere]', mono && 'font-mono text-xs')}>{value}</dd>
								</div>
							) : null,
						)}
					</dl>
				</div>
			) : null}
		</li>
	);
}

export function ReportDetailPage() {
	const id = useRouteDomainId();
	const { date = '' } = useParams();
	const { domain } = useDomain(id);

	const q = useQuery({
		queryKey: ['day-report', id, date],
		queryFn: () => api<DayReport>(`/api/domains/${id}/reports?date=${encodeURIComponent(date)}`),
		enabled: !Number.isNaN(id) && date !== '',
	});

	const name = q.data?.domain ?? domain?.domain;
	const header = (title: string, description?: string) => (
		<PageHeader eyebrow={<BackLink to={`/domains/${id}`}>{name ?? 'Back'}</BackLink>} title={title} description={description} />
	);

	if (q.isPending) {
		return (
			<div className="space-y-6">
				{header(formatDayWithRelative(date))}
				<PageSkeleton label="Loading report" />
			</div>
		);
	}
	if (q.isError) {
		return (
			<div className="space-y-6">
				{header(date ? formatDayWithRelative(date) : 'Report')}
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load this day's report" />
			</div>
		);
	}

	const { summary, sources } = q.data;
	const failing = sources.filter(isFailing);
	const passing = sources.filter((s) => !isFailing(s));
	const rate = passRate(summary.passed, summary.total);

	const hero =
		summary.total === 0
			? null
			: failing.length === 0
				? `${summary.total.toLocaleString()} messages analyzed — everything passed.`
				: `${summary.total.toLocaleString()} messages analyzed — ${summary.failed.toLocaleString()} need attention.`;

	return (
		<div className="space-y-8">
			{header(formatDayWithRelative(date))}

			{summary.total === 0 ? (
				<EmptyState
					icon={<FileText />}
					title="No reports received for this date"
					description="DMARC reports arrive daily from mail providers, usually a day late. Pick another day from the reports list."
				/>
			) : (
				<>
					<p className={cn('flex items-center gap-2 text-base font-medium', failing.length > 0 ? 'text-danger' : 'text-success')}>
						{failing.length > 0 ? <XCircle aria-hidden className="size-5" /> : <CheckCircle2 aria-hidden className="size-5" />}
						{hero}
					</p>
					<StatGroup className={'sm:grid-cols-4'}>
						<Stat label="Pass rate" value={`${rate}%`} />
						<Stat label="Total" value={summary.total.toLocaleString()} />
						<Stat label="Passed" value={summary.passed.toLocaleString()} />
						{summary.failed > 0 ? <Stat label="Failed" value={summary.failed.toLocaleString()} /> : null}
					</StatGroup>

					{failing.length > 0 ? (
						<Section title="Needs attention" description="These sources failed SPF or DKIM for this day.">
							<div className="space-y-3">
								{failing.map((s) => (
									<FailingCard key={sourceKey(s)} src={s} />
								))}
							</div>
						</Section>
					) : null}

					{passing.length > 0 ? (
						<Section title="Passing sources" description="Select a source to see the details.">
							<ul className="overflow-hidden rounded-lg border border-line bg-surface-1">
								{passing.map((s) => (
									<PassingRow key={sourceKey(s)} src={s} />
								))}
							</ul>
						</Section>
					) : null}
				</>
			)}
		</div>
	);
}
