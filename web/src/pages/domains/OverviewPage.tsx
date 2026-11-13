import { Button, EmptyState, PageHeader, Stat, StatGroup, toast } from '@inbox-angel/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Download, Globe, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ClaimCard } from '../../components/domain/ClaimCard';
import { DomainLevelCard } from '../../components/domain/DomainLevelCard';
import { ReportsNotConnected, useWorkspaceReportsNotConnected } from '../../components/ReportsNotConnected';
import { ListSkeleton, LoadError, ReadOnlyNotice, WriteButton } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { sumStats } from '../../lib/dmarc';
import { domainKeys, fetchStats, fetchSummary } from '../../lib/domain-queries';
import { useDomainClaims, useDomains } from '../../lib/queries';
import { useHosted, useSession } from '../../lib/session';
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
	const claims = useDomainClaims().data ?? [];
	const [exporting, setExporting] = useState(false);
	const hosted = useHosted();
	// Hosted, before report intake: a 7-day pass rate would always read "n/a", so say why once instead.
	const reportsOff = useWorkspaceReportsNotConnected();

	// Same keys as the cards use, so each request is made once.
	const stats = useQueries({ queries: domains.map((d) => ({ queryKey: domainKeys.stats(d.id, 7), queryFn: () => fetchStats(d.id, 7) })) });
	// Where each domain stands is the level on its card. A second count here ("Protected", "Needs action") used another
	// model and contradicted the cards, so the summary only states facts both agree on.
	const all = sumStats(stats.flatMap((q) => (q.data ? q.data.stats : [])));

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
			) : domains.length === 0 && claims.length === 0 ? (
				<EmptyState
					icon={<Globe />}
					title="No domains yet"
					description={
						canWrite && hosted
							? 'Add a domain you send email from to see where it stands and what to fix, checked from live DNS.'
							: canWrite
							? 'Add your first domain to start receiving DMARC reports and see where it stands. Domains are managed through Cloudflare, so connect it too.'
							: 'Nothing has been added to this workspace yet. An owner or admin can add the first domain.'
					}
					action={
						canWrite ? (
							<div className="flex flex-wrap justify-center gap-2">
								<Button asChild>
									<Link to="/setup">Add your first domain</Link>
								</Button>
								{hosted ? null : (
									<Button asChild variant="secondary">
										<a href={CONNECT_CLOUDFLARE_DOCS} target="_blank" rel="noreferrer">
											Connect Cloudflare
										</a>
									</Button>
								)}
							</div>
						) : undefined
					}
				/>
			) : null}

			{!list.isPending && !list.isError && claims.length > 0 ? (
				<section aria-labelledby="waiting-heading" className="space-y-4">
					<div className="space-y-1">
						<h2 id="waiting-heading" className="text-lg font-semibold tracking-tight">
							Waiting for verification
						</h2>
						<p className="text-sm text-ink-2">
							{hosted
								? 'Prove you own each one with a DNS record. Then it joins this workspace, and its SPF, DKIM and DMARC are checked from live DNS.'
								: 'These domains are not monitored yet. Prove you own each one with a DNS record; there are no reports or stats until then.'}
						</p>
					</div>
					{claims.map((c) => (
						<ClaimCard key={c.id} claim={c} canWrite={canWrite} />
					))}
				</section>
			) : null}

			{!list.isPending && !list.isError && domains.length > 0 ? (
				<>
					<StatGroup className="sm:grid-cols-2" aria-label="Summary">
						<Stat label={domains.length === 1 ? 'Domain' : 'Domains'} value={domains.length} />
						{reportsOff ? null : <Stat label="Pass rate, 7 days" value={all.passRate !== null ? `${all.passRate}%` : 'n/a'} />}
					</StatGroup>
					{reportsOff ? <ReportsNotConnected /> : null}
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
			) : null}
		</div>
	);
}
