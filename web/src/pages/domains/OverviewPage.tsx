import { Button, EmptyState, PageHeader, Stat, StatGroup, toast } from '@inbox-angel/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Download, Globe, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DomainLevelCard } from '../../components/domain/DomainLevelCard';
import { ListSkeleton, LoadError, ReadOnlyNotice, WriteButton } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { computeStatus, sumStats } from '../../lib/dmarc';
import { domainKeys, fetchStats, fetchSummary } from '../../lib/domain-queries';
import { useDomains } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { DailyStat, Domain } from '../../lib/types';

/** Parents first, each followed by its children. A child whose parent is not monitored stands alone. */
export function buildTree(domains: Domain[]): Array<{ root: Domain; children: Domain[] }> {
	const ids = new Set(domains.map((d) => d.id));
	const kids = new Map<number, Domain[]>();
	const roots: Domain[] = [];
	for (const d of domains) {
		if (d.parent_id !== null && d.parent_id !== undefined && ids.has(d.parent_id)) kids.set(d.parent_id, [...(kids.get(d.parent_id) ?? []), d]);
		else roots.push(d);
	}
	return roots.map((root) => ({ root, children: kids.get(root.id) ?? [] }));
}

function AddDomainButton() {
	const { canWrite } = useSession();
	if (!canWrite) return <WriteButton variant="secondary">Add domain</WriteButton>;
	return (
		<Button asChild variant="secondary">
			<Link to="/add">
				<Plus aria-hidden />
				Add domain
			</Link>
		</Button>
	);
}

const CONNECT_CLOUDFLARE_DOCS = 'https://github.com/fellowship-dev/inbox-angel/blob/main/docs/cloudflare-oauth.md';

export function OverviewPage() {
	const qc = useQueryClient();
	const { canWrite } = useSession();
	const list = useDomains();
	const domains = list.data ?? [];
	const [exporting, setExporting] = useState(false);

	// Same keys as the cards use, so each request is made once.
	const stats = useQueries({ queries: domains.map((d) => ({ queryKey: domainKeys.stats(d.id, 7), queryFn: () => fetchStats(d.id, 7) })) });
	const rows = domains.map((d, i) => {
		const s = stats[i]?.data ? sumStats(stats[i].data.stats) : null;
		return { domain: d, sums: s, status: computeStatus(d.dmarc_policy, s?.passRate != null ? s.passRate / 100 : null) };
	});
	const protectedCount = rows.filter((r) => r.status === 'good').length;
	const needsAction = rows.filter((r) => r.status === 'danger').length;
	const all = sumStats(rows.flatMap((r) => (r.sums ? [{ total: r.sums.total, passed: r.sums.passed, failed: r.sums.failed }] : [])));

	async function exportPdf() {
		setExporting(true);
		try {
			// Every summary must load, or the report would silently leave a domain out. Trends are optional.
			const [summaries, trendResults] = await Promise.all([
				Promise.all(domains.map((d) => qc.fetchQuery({ queryKey: domainKeys.summary(d.id), queryFn: () => fetchSummary(d.id), staleTime: 0 }))),
				Promise.all(domains.map((d) => fetchStats(d.id, 90).catch(() => null))),
			]);
			const trends: Record<number, DailyStat[]> = {};
			domains.forEach((d, i) => {
				const t = trendResults[i];
				if (t) trends[d.id] = t.stats;
			});
			const { downloadPdfReport } = await import('../../lib/pdf/report');
			downloadPdfReport({ summaries, trends });
			toast({ title: 'Report downloaded', description: 'email-auth-report.pdf', variant: 'success' });
		} catch (e) {
			toast({ title: 'Could not export the PDF', description: errorMessage(e), variant: 'danger' });
		} finally {
			setExporting(false);
		}
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title="Domains"
				description="Where each domain stands: can receivers verify your mail, and is spoofing blocked."
				actions={
					<>
						{domains.length > 0 ? (
							<Button variant="secondary" loading={exporting} onClick={exportPdf}>
								<Download aria-hidden />
								{exporting ? 'Generating…' : 'Export PDF'}
							</Button>
						) : null}
						<AddDomainButton />
					</>
				}
			/>
			<ReadOnlyNotice />

			{list.isPending ? (
				<ListSkeleton rows={3} label="Loading domains" />
			) : list.isError ? (
				<LoadError error={list.error} onRetry={() => void list.refetch()} title="Could not load your domains" />
			) : domains.length === 0 ? (
				<EmptyState
					icon={<Globe />}
					title="No domains yet"
					description={
						canWrite
							? 'Add your first domain to start receiving DMARC reports and see where it stands. Domains are managed through Cloudflare, so connect it too.'
							: 'Nothing has been added to this workspace yet. An owner or admin can add the first domain.'
					}
					action={
						canWrite ? (
							<div className="flex flex-wrap justify-center gap-2">
								<Button asChild>
									<Link to="/setup">Add your first domain</Link>
								</Button>
								<Button asChild variant="secondary">
									<a href={CONNECT_CLOUDFLARE_DOCS} target="_blank" rel="noreferrer">
										Connect Cloudflare
									</a>
								</Button>
							</div>
						) : undefined
					}
				/>
			) : (
				<>
					<StatGroup className="sm:grid-cols-4" aria-label="Summary">
						<Stat label={domains.length === 1 ? 'Domain' : 'Domains'} value={domains.length} />
						<Stat label="Protected" value={protectedCount} />
						<Stat label="Needs action" value={needsAction} />
						<Stat label="Pass rate, 7 days" value={all.passRate !== null ? `${all.passRate}%` : 'n/a'} />
					</StatGroup>
					<div className="space-y-6">
						{buildTree(domains).map(({ root, children }) => (
							<div key={root.id} className="space-y-4">
								<DomainLevelCard domain={root} />
								{children.length > 0 ? (
									<div className="ml-3 space-y-4 border-l-2 border-line pl-3 sm:ml-6 sm:pl-6">
										{children.map((c) => (
											<DomainLevelCard key={c.id} domain={c} />
										))}
									</div>
								) : null}
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}
