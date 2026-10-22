import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@inbox-angel/ui';
import { Link } from 'react-router';
import { formatNumber } from '../../lib/format';
import type { FailingSource } from '../../lib/types';
import { ListSkeleton, LoadError, Section } from '../states';
import type { UseQueryResult } from '@tanstack/react-query';

/** Top failing sources (7 days). Hidden when there are none: nothing is failing. */
export function FailingSources({ domainId, q }: { domainId: number; q: UseQueryResult<FailingSource[]> }) {
	if (q.isPending) return <Section title="Top failing sources"><ListSkeleton rows={1} label="Loading failing sources" /></Section>;
	if (q.isError) return <Section title="Top failing sources"><LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load failing sources" /></Section>;
	if (q.data.length === 0) return null;
	return (
		<Section
			title="Top failing sources"
			description="Servers whose mail failed DMARC in the last 7 days."
			actions={
				<span className="flex gap-4 text-sm">
					<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${domainId}/anomalies`}>
						Anomalies
					</Link>
					<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${domainId}/explore`}>
						Explore sources
					</Link>
				</span>
			}
		>
			<Table label="Top failing sources">
				<TableHeader>
					<TableRow>
						<TableHead>Source</TableHead>
						<TableHead>Sending as</TableHead>
						<TableHead className="text-right">Failed messages</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{q.data.map((src) => {
						const name = src.org ?? src.base_domain;
						return (
							<TableRow key={src.source_ip}>
								<TableCell>
									{name ? <span className="block font-semibold">{name}</span> : null}
									<code className="font-mono text-xs text-ink-2">{src.source_ip}</code>
								</TableCell>
								<TableCell className="[overflow-wrap:anywhere]">{src.header_from ?? 'unknown'}</TableCell>
								<TableCell className="text-right tabular-nums">{formatNumber(src.total)}</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</Section>
	);
}
