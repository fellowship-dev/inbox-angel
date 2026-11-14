import { Alert, Button, CheckResult, CheckResultList, LevelCard, Skeleton } from '@ready-set-mail/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { DKIM_WILDCARD_LABEL, dkimWildcardSummary } from '../../lib/dkim-wildcard';
import { previewAssessment, type ClaimPreviewData } from '../../lib/claim-preview';

const RATE_LIMITED = 'Checked too often. Try again in a minute.';

export type { ClaimPreviewData };
const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-sm [overflow-wrap:anywhere]">{children}</code>;

function ago(iso: string, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86400)} d ago`;
}

function DkimRow({ dkim, domain, retry }: { dkim: ClaimPreviewData['dkim']; domain: string; retry: () => void }) {
	if (dkim.status === 'wildcard') return <CheckResult status="neutral" title="DKIM" statusLabel={DKIM_WILDCARD_LABEL} summary={dkimWildcardSummary(domain)} />;
	if (dkim.status === 'found') {
		return (
			<CheckResult status="pass" title="DKIM" statusLabel="Key found" summary={<>Found at {dkim.selectors.map((s, i) => <span key={s}>{i > 0 ? ', ' : ''}<Mono>{s}</Mono></span>)}.</>} />
		);
	}
	if (dkim.status === 'not_found') {
		return <CheckResult status="neutral" title="DKIM" statusLabel="Not found in common places" summary={`We checked ${dkim.scanned} common selectors. Public DNS can't list every DKIM key, so a key may still exist under another name.`} />;
	}
	return <CheckResult status="error" title="DKIM" onRetry={retry} />;
}

const mono = (record: string | null) => (record ? <Mono>{record}</Mono> : null);

function Result({ data, retry }: { data: ClaimPreviewData; retry: () => void }) {
	const { spf, dmarc, domain } = data;

	// The name does not exist: no level and no findings. The overview card says the same, in the same words.
	if (data.nxdomain) {
		return (
			<CheckResultList>
				<CheckResult status="missing" statusLabel="Does not resolve" title="This domain does not resolve" summary="DNS says this name does not exist, so there are no SPF or DMARC records to check. Check the spelling, or register the domain." />
			</CheckResultList>
		);
	}

	// Level and SPF/DMARC findings are the overview's own (assessDomain). If SPF or DMARC could not be read there is no level: a guess would be a made-up result.
	const a = previewAssessment(data);
	const records = [spf.status === 'found' ? { name: 'SPF', record: spf.record } : null, dmarc.record ? { name: 'DMARC', record: dmarc.record } : null].filter((r): r is { name: string; record: string | null } => !!r);
	return (
		<div className="space-y-3">
			{a ? (
				<LevelCard level={a.level} domain={domain} description={a.description} findings={a.findings}>
					{records.length > 0 ? (
						<ul className="space-y-1 text-sm">
							{records.map((r) => (
								<li key={r.name}>
									<span className="text-ink-2">{r.name}: </span>
									{mono(r.record)}
								</li>
							))}
						</ul>
					) : null}
				</LevelCard>
			) : (
				<CheckResultList>
					<CheckResult status="error" title="Protection level" summary="Not shown, because a DNS lookup failed. We don't guess." onRetry={retry} />
					{spf.status === 'error' ? <CheckResult status="error" title="SPF" onRetry={retry} /> : null}
					{dmarc.status === 'error' ? <CheckResult status="error" title="DMARC" onRetry={retry} /> : null}
				</CheckResultList>
			)}
			<CheckResultList>
				{/* With a level, the SPF finding above already says it (from the same lookup count); without one, say it here. */}
				{spf.over_limit && !a ? (
					<CheckResult status="warn" title="SPF" statusLabel="Over 10 lookups" summary={`Receivers may reject mail when SPF needs more than 10 DNS lookups. This record needs ${spf.lookup_count}.`} />
				) : null}
				<DkimRow dkim={data.dkim} domain={domain} retry={retry} />
			</CheckResultList>
		</div>
	);
}

/**
 * What public DNS says about a domain that is claimed but not yet verified. Anyone can look these records up, so it is shown before
 * ownership is proven; the server stores nothing. `lazy` waits for a click (a list of claims must not look up every domain at once).
 */
export function ClaimPreview({ claimId, domain, lazy = false }: { claimId: number | string; domain: string; lazy?: boolean }) {
	const [requested, setRequested] = useState(!lazy);
	const q = useQuery({
		queryKey: ['claim-preview', claimId],
		queryFn: () => api<ClaimPreviewData>(`/api/domains/claims/${claimId}/preview`),
		enabled: requested,
		retry: false,
		staleTime: 60_000,
	});

	if (!requested) {
		return (
			<div>
				<Button variant="secondary" size="sm" onClick={() => setRequested(true)}>
					Check public DNS
				</Button>
			</div>
		);
	}

	const retry = () => void q.refetch();
	const limited = q.error instanceof ApiError && q.error.status === 429;
	let body: ReactNode;
	if (q.data) body = <Result data={q.data} retry={retry} />;
	else if (q.isPending) {
		body = (
			<div aria-busy="true" className="space-y-2">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
				<span className="sr-only">Checking public DNS…</span>
			</div>
		);
	} else if (!limited) {
		body = (
			<CheckResultList>
				<CheckResult status="error" title="Public DNS" onRetry={retry} />
			</CheckResultList>
		);
	}

	return (
		<section aria-labelledby={`claim-preview-${claimId}`} className="space-y-3">
			<div className="space-y-1">
				<h4 id={`claim-preview-${claimId}`} className="text-base font-semibold">
					Public DNS for <span className="font-mono [overflow-wrap:anywhere]">{domain}</span>
				</h4>
				<p className="text-sm text-ink-2">
					Anyone can look these records up. They're shown before you prove ownership so you can see where {domain} stands. Nothing is stored until it's verified.
				</p>
			</div>
			{limited ? <Alert variant="info">{RATE_LIMITED}</Alert> : null}
			{body}
			{q.data ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<p className="text-sm text-ink-2">Checked from public DNS {ago(q.data.checked_at)}.</p>
					<Button variant="secondary" size="sm" loading={q.isFetching} onClick={retry}>
						Check again
					</Button>
				</div>
			) : null}
		</section>
	);
}
