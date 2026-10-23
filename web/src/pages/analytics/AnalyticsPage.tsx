import { Button, PageHeader, Stat, StatGroup, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Badge } from '@inbox-angel/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { FixList } from '../../components/analytics/FixList';
import { ReadinessCard } from '../../components/analytics/ReadinessCard';
import { SenderInventory } from '../../components/analytics/SenderInventory';
import { TrendChart } from '../../components/analytics/TrendChart';
import { WindowPills } from '../../components/reports';
import { ListSkeleton, LoadError, PageSkeleton, Section } from '../../components/states';
import { READINESS_LABEL, fmtPct, useWorkspaceAnalytics, useDomainAnalytics, type WorkspaceAnalytics, type DomainAnalytics } from '../../lib/analytics';
import { formatNumber } from '../../lib/format';
import { DEFAULT_WINDOW, type WindowDays } from '../../lib/reports';
import { useDomainId } from '../../app';
import { useDomain } from '../../lib/queries';
import { BackLink } from '../../components/reports';

type Data = WorkspaceAnalytics | DomainAnalytics;

function Body({ data, days }: { data: Data; days: number }) {
	const workspace = 'domains' in data;
	return (
		<div className="space-y-8">
			<StatGroup className="sm:grid-cols-4" aria-label={`Last ${days} days`}>
				<Stat label="Pass rate" value={fmtPct(data.totals.pass_rate)} />
				<Stat label="Messages" value={formatNumber(data.totals.messages)} />
				<Stat label="Failed" value={formatNumber(data.totals.failed)} />
				<Stat label="Senders" value={formatNumber(data.sender_count)} />
			</StatGroup>

			{!workspace ? (
				<Section title="Enforcement readiness" description="Is it safe to move to the next DMARC step?">
					<ReadinessCard readiness={data.readiness} />
				</Section>
			) : (
				<Section title="Enforcement readiness" description="Per domain, from each domain's last known policy. Open a domain for the live check.">
					{data.domains.length === 0 ? (
						<p className="text-sm text-ink-2">No domains yet.</p>
					) : (
						<Table label="Enforcement readiness by domain">
							<TableHeader>
								<TableRow>
									<TableHead scope="col">Domain</TableHead>
									<TableHead scope="col" className="text-right">Messages (30d)</TableHead>
									<TableHead scope="col" className="text-right">Pass rate</TableHead>
									<TableHead scope="col">Ready for the next step?</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.domains.map((d) => (
									<TableRow key={d.domain_id}>
										<TableCell>
											<Link className="font-mono text-brand-ink underline underline-offset-4" to={`/domains/${d.domain_id}/analytics`}>
												{d.domain}
											</Link>
										</TableCell>
										<TableCell className="text-right tabular-nums">{formatNumber(d.messages)}</TableCell>
										<TableCell className="text-right tabular-nums">{fmtPct(d.pass_rate)}</TableCell>
										<TableCell>
											<Badge variant={d.readiness.status === 'ready' || d.readiness.status === 'complete' ? 'success' : d.readiness.status === 'blocked' ? 'danger' : d.readiness.status === 'caution' ? 'warning' : 'outline'}>
												{READINESS_LABEL[d.readiness.status]}
											</Badge>
											<span className="ml-2 text-sm text-ink-2">{d.readiness.headline}</span>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</Section>
			)}

			<Section title="What to fix next" description="Ranked by how much of your mail each problem touches.">
				<FixList fixes={data.fixes} showDomain={workspace} />
			</Section>

			<Section title="Pass rate trend" description={`Messages per ${days > 30 ? 'week' : 'day'}, passed and failed DMARC.`}>
				<TrendChart trend={data.trend} days={days} />
			</Section>

			<Section title="Sender inventory" description="Every source that sent mail as your domain.">
				<SenderInventory senders={data.senders} showDomains={workspace} alignment={data.alignment} />
				{data.sender_count > data.senders.length ? <p className="text-sm text-ink-2">Showing the {data.senders.length} biggest of {formatNumber(data.sender_count)} senders.</p> : null}
			</Section>
		</div>
	);
}

function Frame({ q, days, setDays, title, description, eyebrow, actions }: { q: { isPending: boolean; isError: boolean; error: unknown; data: Data | undefined; refetch: () => unknown }; days: WindowDays; setDays: (d: WindowDays) => void; title: string; description: string; eyebrow?: React.ReactNode; actions?: React.ReactNode }) {
	return (
		<div className="space-y-6">
			<PageHeader eyebrow={eyebrow} title={title} description={description} actions={actions} />
			<WindowPills value={days} onChange={setDays} />
			{q.isPending ? <ListSkeleton rows={4} label="Loading analytics" /> : q.isError ? <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load analytics" /> : q.data ? <Body data={q.data} days={days} /> : null}
		</div>
	);
}

/** All domains: "what is happening with my mail". */
export function AnalyticsPage() {
	const [days, setDays] = useState<WindowDays>(DEFAULT_WINDOW);
	const q = useWorkspaceAnalytics(days);
	return <Frame q={q} days={days} setDays={setDays} title="Analytics" description="What is happening with your mail, across every domain." />;
}

export function DomainAnalyticsPage() {
	const id = useDomainId();
	const [days, setDays] = useState<WindowDays>(DEFAULT_WINDOW);
	const { domain, isPending } = useDomain(id);
	const q = useDomainAnalytics(id, days);
	if (isPending && !q.data) return <PageSkeleton label="Loading analytics" />;
	const name = domain?.domain ?? q.data?.domain.domain ?? 'Domain';
	return (
		<Frame
			q={q}
			days={days}
			setDays={setDays}
			title={`Analytics: ${name}`}
			description="Senders, pass rate and what to fix next for this domain."
			eyebrow={<BackLink to={`/domains/${id}`}>{name}</BackLink>}
			actions={
				<Button asChild variant="secondary">
					<Link to={`/domains/${id}/reports`}>Report browser</Link>
				</Button>
			}
		/>
	);
}
