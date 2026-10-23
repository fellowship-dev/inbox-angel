import { EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { BackLink, ReporterAuthBadge, Segmented, useRouteDomainId } from '../../components/reports';
import { ListSkeleton, LoadError } from '../../components/states';
import { api } from '../../lib/api';
import { useDomain, useDomains } from '../../lib/queries';
import { formatDayWithRelative, isoDay, passRate, plural, rateTone, type RateTone } from '../../lib/reports';
import type { AggregateReport } from '../../lib/types';

const TONE_TEXT: Record<RateTone, string> = { success: 'text-success', warning: 'text-warning', danger: 'text-danger' };

type Scope = 'domain' | 'all';

/**
 * Deliberate change from the Preact dashboard: that page listed every domain's reports whatever the route said.
 * Here the route's domain is the default scope, with an "All domains" toggle.
 */
export function ReportBrowserPage() {
	const id = useRouteDomainId();
	const { domain, isPending: domainPending } = useDomain(id);
	const domains = useDomains();
	const [scope, setScope] = useState<Scope>('domain');

	const q = useQuery({ queryKey: ['reports', 200], queryFn: () => api<{ reports: AggregateReport[] }>('/api/reports?limit=200') });

	const idByName = new Map((domains.data ?? []).map((d) => [d.domain, d.id]));
	const all = q.data?.reports ?? [];
	// If the domain is unknown (still loading failed or deleted) there is nothing sensible to filter by.
	const filterName = scope === 'domain' ? domain?.domain : undefined;
	const visible = filterName ? all.filter((r) => r.domain === filterName) : all;
	const showDomainColumn = !filterName;
	const loading = q.isPending || domainPending;

	return (
		<div className="space-y-6">
			<PageHeader
				eyebrow={<BackLink to={`/domains/${id}`}>{domain?.domain ?? 'Back'}</BackLink>}
				title="Reports"
				description="Aggregate DMARC reports from mail providers, newest first."
			/>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<Segmented<Scope>
					label="Which domains"
					value={scope}
					onChange={setScope}
					options={[
						{ value: 'domain', label: domain?.domain ?? 'This domain' },
						{ value: 'all', label: 'All domains' },
					]}
				/>
				{!loading && !q.isError ? <p className="text-sm text-ink-2">{plural(visible.length, 'report')}</p> : null}
			</div>

			{loading ? (
				<ListSkeleton rows={5} label="Loading reports" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load reports" />
			) : visible.length === 0 ? (
				<EmptyState
					icon={<FileText />}
					title={filterName ? `No reports for ${filterName} yet` : 'No reports yet'}
					description="DMARC reports arrive daily from mail providers. Make sure your DMARC record's rua= address points to Inbox Angel, then check back tomorrow."
				/>
			) : (
				<Table label="DMARC aggregate reports">
					<TableHeader>
						<TableRow>
							<TableHead>Date</TableHead>
							{showDomainColumn ? <TableHead>Domain</TableHead> : null}
							<TableHead>Reporter</TableHead>
							<TableHead className="text-right">Pass</TableHead>
							<TableHead className="text-right">Fail</TableHead>
							<TableHead className="text-right">Total</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{visible.map((r) => {
							const pct = passRate(r.pass_count, r.total_count);
							const target = idByName.get(r.domain) ?? id;
							return (
								<TableRow key={r.id}>
									<TableCell className="whitespace-nowrap">
										<Link to={`/domains/${target}/reports/${isoDay(r.date_begin)}`} className="rounded-sm text-brand-ink underline-offset-4 hover:underline">
											{formatDayWithRelative(r.date_begin)}
										</Link>
									</TableCell>
									{showDomainColumn ? <TableCell>{r.domain}</TableCell> : null}
									<TableCell>
										{r.org_name}
										<ReporterAuthBadge auth={r.reporter_auth} />
									</TableCell>
									<TableCell className="text-right tabular-nums">{r.pass_count.toLocaleString()}</TableCell>
									<TableCell className={cn('text-right tabular-nums', r.fail_count > 0 && 'font-semibold text-danger')}>{r.fail_count.toLocaleString()}</TableCell>
									<TableCell className="whitespace-nowrap text-right tabular-nums">
										{pct !== null ? <span className={cn('mr-2 font-semibold', TONE_TEXT[rateTone(pct)])}>{pct}%</span> : null}
										{r.total_count.toLocaleString()}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
