import { Badge, Button, EmptyState, PageHeader } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Inbox } from 'lucide-react';
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

			{q.isPending ? (
				<ListSkeleton rows={4} label="Loading sources" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load sources" />
			) : visible.length === 0 ? (
				filter === 'anomalies' ? (
					<EmptyState
						icon={<CheckCircle2 />}
						title={`No anomalies in the last ${days} days`}
						description="All sending sources are passing DMARC."
						action={
							<Button variant="secondary" onClick={() => setFilter('all')}>
								Show all sources
							</Button>
						}
					/>
				) : (
					<EmptyState
						icon={<Inbox />}
						title={`No sources in the last ${days} days`}
						description="No DMARC reports received yet. Reports arrive daily from mail providers once your DMARC record points to Inbox Angel."
						action={days < 90 ? <Button variant="secondary" onClick={() => setDays(90)}>Look back 90 days</Button> : undefined}
					/>
				)
			) : (
				<SourceTable sources={visible} domainId={id} label="Sending sources" />
			)}
		</div>
	);
}
