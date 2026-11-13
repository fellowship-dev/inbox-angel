import { Alert, Button, CheckResult, CheckResultList, LevelCard, Skeleton } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { assessDomain } from '../../lib/levels';

/** GET /api/domains/claims/:id/preview: public DNS only, nothing stored (src/domains/claim-preview.ts). */
export interface ClaimPreviewData {
	domain: string;
	checked_at: string;
	source: 'public_dns';
	cached: boolean;
	spf: { status: 'found' | 'missing' | 'invalid' | 'error'; record: string | null; lookup_count: number | null; over_limit: boolean; issues: string[] };
	dmarc: { status: 'found' | 'missing' | 'invalid' | 'multiple' | 'error'; record: string | null; policy: string | null; inherited: boolean; found_at: string | null };
	dkim: { status: 'found' | 'not_found' | 'error'; selectors: string[]; scanned: number; failed: number };
	mx: { status: 'found' | 'none' | 'error' };
	lookup_failed: string[];
}

const RATE_LIMITED = 'Checked too often. Try again in a minute.';

const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-sm [overflow-wrap:anywhere]">{children}</code>;

function ago(iso: string, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86400)} d ago`;
}

function SpfRow({ spf, domain, retry }: { spf: ClaimPreviewData['spf']; domain: string; retry: () => void }) {
	const record = spf.record ? <Mono>{spf.record}</Mono> : null;
	switch (spf.status) {
		case 'found':
			return spf.over_limit ? (
				<CheckResult status="warn" title="SPF" statusLabel="Over 10 lookups" summary={`Receivers may reject mail when SPF needs more than 10 DNS lookups. This record needs ${spf.lookup_count ?? 'more than 10'}.`}>
					{record}
				</CheckResult>
			) : (
				<CheckResult status="pass" title="SPF" statusLabel="SPF record published">
					{record}
				</CheckResult>
			);
		case 'missing':
			return <CheckResult status="missing" title="SPF" summary={`No SPF record. Receivers can't tell which servers may send for ${domain}.`} />;
		case 'invalid':
			return (
				<CheckResult status="fail" title="SPF" summary={`The SPF record doesn't parse, so receivers treat it as broken.${spf.issues[0] ? ` ${spf.issues[0]}` : ''}`}>
					{record}
				</CheckResult>
			);
		default:
			return <CheckResult status="error" title="SPF" onRetry={retry} />;
	}
}

function DmarcRow({ dmarc, retry }: { dmarc: ClaimPreviewData['dmarc']; retry: () => void }) {
	const record = dmarc.record ? <Mono>{dmarc.record}</Mono> : null;
	const inherited = dmarc.inherited && dmarc.found_at ? `Inherited from ${dmarc.found_at}.` : '';
	switch (dmarc.status) {
		case 'found':
			return dmarc.policy === 'none' ? (
				<CheckResult status="warn" title="DMARC" statusLabel="Monitoring only (p=none)" summary={['Failing mail is still delivered.', inherited].filter(Boolean).join(' ')}>
					{record}
				</CheckResult>
			) : (
				<CheckResult status="pass" title="DMARC" statusLabel={`Enforced (p=${dmarc.policy})`} summary={inherited || undefined}>
					{record}
				</CheckResult>
			);
		case 'missing':
			return <CheckResult status="missing" title="DMARC" summary="No DMARC record." />;
		case 'invalid':
			return (
				<CheckResult status="fail" title="DMARC" summary="The DMARC record doesn't parse.">
					{record}
				</CheckResult>
			);
		case 'multiple':
			return <CheckResult status="fail" title="DMARC" summary="More than one DMARC record is published, so receivers ignore them all." />;
		default:
			return <CheckResult status="error" title="DMARC" onRetry={retry} />;
	}
}

function DkimRow({ dkim, retry }: { dkim: ClaimPreviewData['dkim']; retry: () => void }) {
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

function Result({ data, retry }: { data: ClaimPreviewData; retry: () => void }) {
	const { spf, dmarc } = data;
	// The level counts only what was read. If SPF or DMARC could not be read there is no level: a guess would be a made-up result.
	const level = spf.status !== 'error' && dmarc.status !== 'error'
		? assessDomain(
				{
					spf_record: spf.status === 'found' ? spf.record : null,
					dmarc_policy: dmarc.status === 'found' ? dmarc.policy : null,
					dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null,
				},
				{ nullMeans: 'missing' },
			)
		: null;
	return (
		<div className="space-y-3">
			{level ? (
				<LevelCard level={level.level} domain={data.domain} description={level.description} />
			) : (
				<CheckResultList>
					<CheckResult status="error" title="Protection level" summary="Not shown, because a DNS lookup failed. We don't guess." onRetry={retry} />
				</CheckResultList>
			)}
			<CheckResultList>
				<SpfRow spf={spf} domain={data.domain} retry={retry} />
				<DmarcRow dmarc={dmarc} retry={retry} />
				<DkimRow dkim={data.dkim} retry={retry} />
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
