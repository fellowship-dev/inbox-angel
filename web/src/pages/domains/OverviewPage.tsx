import { Button, EmptyState, PageHeader, statusRank, toast } from '@inbox-angel/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ClaimCard } from '../../components/domain/ClaimCard';
import { DomainRow } from '../../components/domain/DomainRow';
import { GetStarted } from '../../components/GetStarted';
import { ListSkeleton, LoadError, ReadOnlyNotice, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { sumStats } from '../../lib/dmarc';
import { domainKeys, fetchStats, fetchSummary } from '../../lib/domain-queries';
import { getStartedSteps } from '../../lib/get-started';
import { hostedKey, useHostedConfig, type HostedResponse } from '../../lib/hosted';
import { useDomainClaims, useDomains } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { DailyStat, Domain } from '../../lib/types';
import { domainVerdict, unavailableVerdict, workspaceAnswer, type DomainVerdict, type ReportTotals } from '../../lib/verdict';

/** Days of reports each row's evidence covers. */
const WINDOW = 30;

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

export function OverviewPage() {
	const qc = useQueryClient();
	const { canWrite, status } = useSession();
	const list = useDomains();
	const domains = list.data ?? [];
	const claims = useDomainClaims().data ?? [];
	const [exporting, setExporting] = useState(false);
	const listId = useId();

	// One stored-DNS summary and one report total per domain; the domain page reuses both from the cache.
	const summaries = useQueries({ queries: domains.map((d) => ({ queryKey: domainKeys.summary(d.id), queryFn: () => fetchSummary(d.id) })) });
	const stats = useQueries({ queries: domains.map((d) => ({ queryKey: domainKeys.stats(d.id, WINDOW), queryFn: () => fetchStats(d.id, WINDOW) })) });
	const hostedOn = useHostedConfig();
	const hosted = useQueries({ queries: domains.map((d) => ({ queryKey: hostedKey(d.id), queryFn: () => api<HostedResponse>(`/api/domains/${d.id}/hosted`), enabled: hostedOn })) });

	const totals: Array<ReportTotals | null | undefined> = stats.map((q) => {
		if (q.isPending) return undefined;
		if (q.isError) return null;
		const s = sumStats(q.data.stats);
		return { total: s.total, passed: s.passed, failed: s.failed, passRate: s.passRate, days: WINDOW };
	});
	const verdicts: Array<DomainVerdict | null> = domains.map((d, i) => {
		const sq = summaries[i]!;
		if (sq.isError) return unavailableVerdict(errorMessage(sq.error));
		const h = hosted[i]!;
		if (sq.isPending || stats[i]!.isPending || (hostedOn && h.isPending)) return null;
		const info = hostedOn && h.data?.enabled ? h.data : null;
		return domainVerdict(d, sq.data, totals[i], info);
	});
	const byId = new Map(domains.map((d, i) => [d.id, { domain: d, verdict: verdicts[i] ?? null, retry: summaries[i]!.isError ? () => void summaries[i]!.refetch() : undefined }]));

	// Most urgent first, a subdomain right under its parent. Until every row is known the order stays as listed,
	// so rows do not jump while they load.
	const settled = verdicts.every(Boolean);
	const rank = (d: Domain) => statusRank(byId.get(d.id)?.verdict?.status ?? 'unknown');
	const cmp = (a: Domain, b: Domain) => rank(a) - rank(b) || a.domain.localeCompare(b.domain);
	const groups = buildTree(domains).map((g) => ({ ...g, children: settled ? [...g.children].sort(cmp) : g.children }));
	if (settled) groups.sort((a, b) => Math.min(rank(a.root), ...a.children.map(rank)) - Math.min(rank(b.root), ...b.children.map(rank)) || a.root.domain.localeCompare(b.root.domain));
	const ordered = groups.flatMap((g) => [{ d: g.root, parent: undefined as string | undefined }, ...g.children.map((c) => ({ d: c, parent: g.root.domain }))]);

	const answer = workspaceAnswer(domains.map((d, i) => ({ name: d.domain, verdict: verdicts[i] ?? null })), claims.length);
	const steps = getStartedSteps({
		hosted: status?.mode === 'saas',
		domains,
		claims: claims.length,
		summaries: summaries.map((q) => (q.isPending ? undefined : q.isError ? null : q.data)),
		verdicts,
		reports: totals,
	});

	async function exportPdf() {
		setExporting(true);
		try {
			// Every summary must load, or the report would silently leave a domain out. Trends are optional.
			const [summaryData, trendResults] = await Promise.all([
				Promise.all(domains.map((d) => qc.fetchQuery({ queryKey: domainKeys.summary(d.id), queryFn: () => fetchSummary(d.id), staleTime: 0 }))),
				Promise.all(domains.map((d) => fetchStats(d.id, 90).catch(() => null))),
			]);
			const trends: Record<number, DailyStat[]> = {};
			domains.forEach((d, i) => {
				const t = trendResults[i];
				if (t) trends[d.id] = t.stats;
			});
			const { downloadPdfReport } = await import('../../lib/pdf/report');
			downloadPdfReport({ summaries: summaryData, trends });
			toast({ title: 'Report downloaded', description: 'email-auth-report.pdf', variant: 'success' });
		} catch (e) {
			toast({ title: 'Could not export the PDF', description: errorMessage(e), variant: 'danger' });
		} finally {
			setExporting(false);
		}
	}

	const empty = domains.length === 0 && claims.length === 0;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Domains"
				actions={
					<>
						{domains.length > 0 ? (
							<Button variant="secondary" loading={exporting} onClick={exportPdf}>
								<Download aria-hidden />
								{exporting ? 'Generating…' : 'Export PDF'}
							</Button>
						) : null}
						{!empty || !canWrite ? <AddDomainButton /> : null}
					</>
				}
			/>
			<ReadOnlyNotice />

			{list.isPending ? (
				<ListSkeleton rows={3} label="Loading domains" />
			) : list.isError ? (
				<LoadError error={list.error} onRetry={() => void list.refetch()} title="Could not load your domains" />
			) : (
				<>
					<div className="space-y-1">
						<p className="text-lg font-semibold tracking-tight text-ink-1 [overflow-wrap:anywhere] sm:text-xl" aria-live="polite" data-testid="am-i-done">
							{answer}
						</p>
						{!empty ? <p className="max-w-prose text-sm text-ink-2">Each domain below says what public DNS and its last {WINDOW} days of reports show, and who acts next. Most urgent first.</p> : null}
					</div>

					{canWrite ? <GetStarted steps={steps} /> : null}

					{empty && !canWrite ? (
						<EmptyState
							title="This workspace has no domains yet"
							description="An owner or admin adds them. Each domain then appears here with its level, what is true now and what to do next."
						/>
					) : null}

					{claims.length > 0 ? (
						<section aria-labelledby="waiting-heading" className="space-y-4">
							<div className="space-y-1">
								<h2 id="waiting-heading" className="text-lg font-semibold tracking-tight">
									Waiting for verification
								</h2>
								<p className="text-sm text-ink-2">These domains are not monitored yet. Prove you own each one with a DNS record; there are no reports or stats until then.</p>
							</div>
							{claims.map((c) => (
								<ClaimCard key={c.id} claim={c} canWrite={canWrite} preview="lazy" />
							))}
						</section>
					) : null}

					{domains.length > 0 ? (
						<section aria-labelledby={listId} className="space-y-3">
							<h2 id={listId} className="sr-only">
								Your domains
							</h2>
							<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1">
								{ordered.map(({ d, parent }) => {
									const row = byId.get(d.id)!;
									return <DomainRow key={d.id} domain={d} parent={parent} verdict={row.verdict} canWrite={canWrite} onRetry={row.retry} />;
								})}
							</ul>
						</section>
					) : null}
				</>
			)}
		</div>
	);
}
