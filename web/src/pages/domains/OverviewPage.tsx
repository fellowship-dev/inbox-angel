import { Button, EmptyState, PageHeader, statusRank, toast } from '@ready-set-mail/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ClaimCard } from '../../components/domain/ClaimCard';
import { DomainRow } from '../../components/domain/DomainRow';
import { GetStarted } from '../../components/GetStarted';
import { ReportsNotConnected, useWorkspaceReportsNotConnected } from '../../components/ReportsNotConnected';
import { ListSkeleton, LoadError, ReadOnlyNotice, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { domainKeys, fetchStats, fetchSummary, useDomainSummaries } from '../../lib/domain-queries';
import { getStartedSteps } from '../../lib/get-started';
import { hostedKey, useHostedConfig, type HostedResponse } from '../../lib/hosted';
import { useDomainClaims, useDomains } from '../../lib/queries';
import { useHosted, useSession } from '../../lib/session';
import type { DailyStat, Domain, DomainCheckSummary } from '../../lib/types';
import { domainVerdict, totalsFromSummary, unavailableVerdict, workspaceAnswer, type DomainVerdict, type ReportTotals } from '../../lib/verdict';

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

/**
 * Every domain as a row, at any depth: each under its nearest ancestor that is in the list (following parent_id), a
 * domain whose parent is absent (or whose chain loops) as a root. Siblings and root groups are ordered by `cmp`, a group
 * ranking by its most urgent member, so every domain counted in the answer has exactly one row.
 */
export function domainRows(domains: Domain[], rank: (d: Domain) => number = () => 0): Array<{ d: Domain; parent?: string; depth: number }> {
	const byId = new Map(domains.map((d) => [d.id, d]));
	const parentOf = (d: Domain): Domain | null => {
		// Nearest present ancestor, never itself (a loop makes the domain a root).
		const seen = new Set<number>([d.id]);
		let p = d.parent_id ?? null;
		while (p !== null && p !== undefined) {
			if (seen.has(p)) return null;
			seen.add(p);
			const hit = byId.get(p);
			if (hit) {
				// Walking on from hit must not lead back to d either.
				let q = hit.parent_id ?? null;
				const chain = new Set<number>([hit.id]);
				while (q !== null && q !== undefined && byId.has(q)) {
					if (q === d.id || chain.has(q)) return null;
					chain.add(q);
					q = byId.get(q)!.parent_id ?? null;
				}
				return hit;
			}
			return null; // the parent is not in this workspace's list: the domain stands alone
		}
		return null;
	};
	const kids = new Map<number, Domain[]>();
	const roots: Domain[] = [];
	for (const d of domains) {
		const p = parentOf(d);
		if (p) kids.set(p.id, [...(kids.get(p.id) ?? []), d]);
		else roots.push(d);
	}
	const best = new Map<number, number>();
	const subtree = (d: Domain): number => {
		if (best.has(d.id)) return best.get(d.id)!;
		const r = Math.min(rank(d), ...(kids.get(d.id) ?? []).map(subtree));
		best.set(d.id, r);
		return r;
	};
	const order = (a: Domain, b: Domain) => subtree(a) - subtree(b) || a.domain.localeCompare(b.domain);
	const out: Array<{ d: Domain; parent?: string; depth: number }> = [];
	const visit = (d: Domain, depth: number, parent?: string) => {
		out.push({ d, parent, depth });
		for (const c of [...(kids.get(d.id) ?? [])].sort(order)) visit(c, depth + 1, d.domain);
	};
	for (const r of [...roots].sort(order)) visit(r, 0);
	return out;
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
	const { canWrite } = useSession();
	const list = useDomains();
	const domains = list.data ?? [];
	const claims = useDomainClaims().data ?? [];
	const [exporting, setExporting] = useState(false);
	const listId = useId();
	const hostedMode = useHosted();
	// Hosted, before report intake: no domain can have reports, so say why once and make no pass-rate claim.
	const reportsOff = useWorkspaceReportsNotConnected();

	// One request for every domain's stored DNS facts and 30-day report totals (paged by 200); hosted status per domain only
	// when hosted records are on for the deployment.
	const batch = useDomainSummaries(domains.length > 0);
	const hostedOn = useHostedConfig();
	const hosted = useQueries({ queries: domains.map((d) => ({ queryKey: hostedKey(d.id), queryFn: () => api<HostedResponse>(`/api/domains/${d.id}/hosted`), enabled: hostedOn })) });

	const idByName = new Map(domains.map((d) => [d.domain, d.id]));
	const summaryOf = (d: Domain): DomainCheckSummary | null | undefined => (batch.isPending ? undefined : batch.isError ? null : (batch.data.get(d.id) ?? null));
	const totals: Array<ReportTotals | null | undefined> = domains.map((d) => {
		const s = summaryOf(d);
		return s ? totalsFromSummary(s, WINDOW) : s;
	});
	const verdicts: Array<DomainVerdict | null> = domains.map((d, i) => {
		const s = summaryOf(d);
		if (batch.isError) return unavailableVerdict(errorMessage(batch.error), d.domain);
		const h = hosted[i]!;
		if (s === undefined || (hostedOn && h.isPending)) return null;
		if (s === null) return unavailableVerdict('it is not in the summary yet. Reload the page.', d.domain);
		const info = hostedOn && h.data?.enabled ? h.data : null;
		return domainVerdict(d, s, totals[i], info, undefined, { hostedMode, idByName });
	});
	const retry = batch.isError ? () => void batch.refetch() : undefined;
	const byId = new Map(domains.map((d, i) => [d.id, { domain: d, verdict: verdicts[i] ?? null, retry }]));

	// Most urgent first, a subdomain right under its parent. Until every row is known the order stays as listed,
	// so rows do not jump while they load.
	const settled = verdicts.every(Boolean);
	const rank = (d: Domain) => statusRank(byId.get(d.id)?.verdict?.status ?? 'unknown');
	// Every domain has a row at any depth (a sub-subdomain under its nearest listed ancestor).
	const ordered = domainRows(domains, settled ? rank : () => 0);

	const answer = workspaceAnswer(domains.map((d, i) => ({ name: d.domain, verdict: verdicts[i] ?? null })), claims.length);
	const steps = getStartedSteps({
		hosted: hostedMode,
		domains,
		claims: claims.length,
		summaries: domains.map(summaryOf),
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
						{!empty ? (
							<p className="max-w-prose text-sm text-ink-2">
								{reportsOff ? 'Each domain below says what public DNS shows, and who acts next. Most urgent first.' : `Each domain below says what public DNS and its last ${WINDOW} days of reports show, and who acts next. Most urgent first.`}
							</p>
						) : null}
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
								<p className="text-sm text-ink-2">
									{/* Both modes show a live DNS preview on these cards, so "not monitored" must not read as "nothing to see". */}
									Prove you own each one with a DNS record. Until then a domain is not monitored: there are no stored checks, stats or alerts, only a live look at its DNS.
								</p>
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
							{reportsOff ? <ReportsNotConnected /> : null}
							<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1">
								{ordered.map(({ d, parent, depth }) => {
									const row = byId.get(d.id)!;
									return <DomainRow key={d.id} domain={d} parent={parent} depth={depth} verdict={row.verdict} canWrite={canWrite} onRetry={row.retry} hideEvidence={reportsOff} />;
								})}
							</ul>
						</section>
					) : null}
				</>
			)}
		</div>
	);
}
