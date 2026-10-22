import { EmptyState, PageHeader } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { BackLink, SourceTable, WindowPills, useRouteDomainId } from '../../components/reports';
import { ListSkeleton, LoadError, Section } from '../../components/states';
import { api } from '../../lib/api';
import { useDomain } from '../../lib/queries';
import { DEFAULT_WINDOW, plural, splitActive, type WindowDays } from '../../lib/reports';
import type { AnomalySource } from '../../lib/types';

export function AnomaliesPage() {
	const id = useRouteDomainId();
	const { domain } = useDomain(id);
	const [days, setDays] = useState<WindowDays>(DEFAULT_WINDOW);

	const q = useQuery({
		queryKey: ['anomalies', id, days],
		queryFn: () => api<{ days: number; domain: string; anomalies: AnomalySource[] }>(`/api/domains/${id}/anomalies?days=${days}`),
		enabled: !Number.isNaN(id),
	});
	const name = domain?.domain ?? q.data?.domain;
	const { active, older } = splitActive(q.data?.anomalies ?? []);

	return (
		<div className="space-y-6">
			<PageHeader
				eyebrow={<BackLink to={`/domains/${id}`}>{name ?? 'Back'}</BackLink>}
				title="Anomalies"
				description="Sources that failed SPF or DKIM."
				actions={<WindowPills value={days} onChange={setDays} />}
			/>

			{q.isPending ? (
				<ListSkeleton rows={3} label="Loading anomalies" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load anomalies" />
			) : active.length + older.length === 0 ? (
				<EmptyState icon={<CheckCircle2 />} title={`No anomalies in the last ${days} days`} description="All sending sources are passing DMARC. Nothing to fix." />
			) : (
				<>
					{active.length > 0 ? (
						<Section title={`Active: ${plural(active.length, 'source')}`} description="Failing within the last 2 days.">
							<SourceTable sources={active} domainId={id} label="Active anomalies" />
						</Section>
					) : null}
					{older.length > 0 ? (
						<Section title={`Older: ${plural(older.length, 'source')}`} description="Not seen in 2+ days, may be resolved.">
							<SourceTable sources={older} domainId={id} label="Older anomalies" />
						</Section>
					) : null}
				</>
			)}
		</div>
	);
}
