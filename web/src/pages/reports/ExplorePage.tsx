import { Badge, Button, EmptyState, PageHeader } from '@ready-set-mail/ui';
import { ReportsNotConnected, useReportsNotConnected } from '../../components/ReportsNotConnected';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BackLink, Segmented, SourceTable, WindowPills, useRouteDomainId } from '../../components/reports';
import { ListSkeleton, LoadError } from '../../components/states';
import { api } from '../../lib/api';
import { useDomain } from '../../lib/queries';
import { DEFAULT_WINDOW, isFailing, plural, type WindowDays } from '../../lib/reports';
import type { AnomalySource } from '../../lib/types';

type Filter = 'all' | 'anomalies';

export function ExplorePage() {
	const id = useRouteDomainId();
	const { domain } = useDomain(id);
	const [days, setDays] = useState<WindowDays>(DEFAULT_WINDOW);
	const [filter, setFilter] = useState<Filter>('all');
	const reportsOff = useReportsNotConnected(domain);

	const q = useQuery({
		queryKey: ['explore', id, days],
		queryFn: () => api<{ days: number; domain: string; sources: AnomalySource[] }>(`/api/domains/${id}/explore?days=${days}`),
		enabled: !Number.isNaN(id),
	});

	const name = domain?.domain ?? q.data?.domain;
	const sources = q.data?.sources ?? [];
	const anomalyCount = sources.filter(isFailing).length;
	const visible = filter === 'anomalies' ? sources.filter(isFailing) : sources;

	return (
		<div className="space-y-6">
			<PageHeader
				eyebrow={<BackLink to={`/domains/${id}`}>{name ?? 'Domain'}</BackLink>}
				title="Sources"
				description="Every server that sent mail as this domain, and whether it passed SPF and DKIM."
			/>

			<div className="flex flex-wrap items-center gap-3">
				<Segmented<Filter>
					label="Filter sources"
					value={filter}
					onChange={setFilter}
					options={[
						{ value: 'all', label: 'All' },
						{
							value: 'anomalies',
							name: `Anomalies, ${plural(anomalyCount, 'source')}`,
							label: (
								<>
									Anomalies
									{anomalyCount > 0 ? <Badge variant="danger">{anomalyCount}</Badge> : null}
								</>
							),
						},
					]}
				/>
				<WindowPills value={days} onChange={setDays} />
			</div>

			{reportsOff ? (
				<ReportsNotConnected domain={domain?.domain} />
			) : q.isPending ? (
				<ListSkeleton rows={4} label="Loading sources" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load sources" />
			) : visible.length === 0 ? (
				filter === 'anomalies' && sources.length > 0 ? (
					<EmptyState
						title={`No failing sources in the last ${days} days`}
						description={`None of the ${sources.length} sources in the reports for this window failed SPF or DKIM. The full list is under All.`}
						action={
							<Button variant="secondary" onClick={() => setFilter('all')}>
								Show all sources
							</Button>
						}
					/>
				) : (
					<EmptyState
						title={`No sources in the last ${days} days`}
						description="No DMARC reports arrived in this window. Receivers send them about once a day once your DMARC record points to Ready Set Mail; a longer window may show older ones."
						action={days < 90 ? <Button variant="secondary" onClick={() => setDays(90)}>Look back 90 days</Button> : undefined}
					/>
				)
			) : (
				<SourceTable sources={visible} domainId={id} label="Sending sources" />
			)}
		</div>
	);
}
