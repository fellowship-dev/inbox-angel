import { Alert, Badge, Button, CheckResult, CheckResultList, FieldError, FieldHint, Input, Label, PageHeader, RecordBlock, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ClaimCard } from '../../components/domain/ClaimCard';
import { InheritanceBanner } from '../../components/domain/InheritanceBanner';
import { ReadOnlyNotice, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { normalizeDomain } from '../../lib/dmarc';
import { domainKeys, type DnsCheck } from '../../lib/domain-queries';
import type { AddDomainResult, PendingDomainResult } from '../../lib/types';

const POLL_MS = 15_000;

interface Zone {
	id: string;
	name: string;
	status: string;
}

/** Checks right away, then every 15 s until the record (with our rua) is seen. A failed lookup keeps polling and is never "not found". */
function LiveDnsCheck({ domainId, rua }: { domainId: number; rua: string }) {
	const q = useQuery({
		queryKey: domainKeys.dnsCheck(domainId),
		queryFn: () => api<DnsCheck>(`/api/domains/${domainId}/dns-check`),
		staleTime: 0,
		retry: false,
		refetchInterval: (query) => (query.state.data?.found && query.state.data.has_rua && !query.state.data.error ? false : POLL_MS),
	});
	const title = 'Your DMARC record';

	let row;
	if (q.isPending) {
		row = (
			<li aria-busy="true" className="rounded-lg border border-line p-4">
				<Skeleton className="h-5 w-1/2" />
				<span className="sr-only">Checking for your DNS record…</span>
			</li>
		);
	} else if (q.isError || q.data.error) {
		row = <CheckResult status="error" title={title} summary="Could not check DNS just now. Add the record above and you are done; we keep trying every 15 seconds." onRetry={() => void q.refetch()} />;
	} else if (q.data.found && q.data.has_rua) {
		row = <CheckResult status="pass" title={title} statusLabel="Detected" summary="DNS record detected! Reports will start arriving within 24 hours." />;
	} else if (q.data.found) {
		row = (
			<CheckResult status="warn" title={title} statusLabel="Missing rua" summary="TXT record found, but the rua= address is missing. Double-check you copied the full value above.">
				Expected: <code className="font-mono">rua=mailto:{rua}</code>
			</CheckResult>
		);
	} else {
		row = <CheckResult status="missing" title={title} summary="DNS record not detected yet. We check every 15 seconds; DNS changes can take a few minutes to propagate." />;
	}
	return <CheckResultList aria-live="polite">{row}</CheckResultList>;
}

function SetupStep({ result }: { result: AddDomainResult }) {
	const { domain } = result;
	const record = `v=DMARC1; p=none; rua=mailto:${domain.rua_address}`;
	return (
		<div className="max-w-2xl space-y-6">
			<PageHeader
				title="Add this DNS record"
				description={
					<>
						Log in to wherever you manage <strong>{domain.domain}</strong> (GoDaddy, Namecheap, Cloudflare, Route 53 …) and add this TXT record.
					</>
				}
				eyebrow={
					<Badge variant="success">
						<CheckCircle2 aria-hidden />
						Domain added
					</Badge>
				}
			/>
			{result.parent_context ? <InheritanceBanner pc={result.parent_context} subdomain={domain.domain} /> : null}
			<RecordBlock title="DMARC record" record={{ type: 'TXT', name: `_dmarc.${domain.domain}`, value: record, ttl: '3600 (or your provider default)' }} />
			<p className="text-sm text-ink-2">
				<strong className="text-ink-1">p=none</strong> means you are just watching. No email gets blocked or redirected. Once DMARC reports start coming in (usually within 24 hours), the dashboard shows whether your mail is fully aligned and when it is safe to enforce.
			</p>
			{result.manual_dns && result.dns_instructions ? (
				<Alert variant="warning" title="Also add">
					{result.dns_instructions}
				</Alert>
			) : null}
			<LiveDnsCheck domainId={domain.id} rua={domain.rua_address} />
			<Button asChild>
				<Link to={`/domains/${domain.id}`}>Go to {domain.domain}</Link>
			</Button>
		</div>
	);
}

export function AddDomainPage() {
	const qc = useQueryClient();
	const [input, setInput] = useState('');
	const [manual, setManual] = useState(false);
	const [result, setResult] = useState<AddDomainResult | null>(null);
	const [pending, setPending] = useState<PendingDomainResult | null>(null);

	// A missing Cloudflare token (400) or any failure just means "type it in".
	const zonesQ = useQuery({ queryKey: domainKeys.zones, queryFn: () => api<{ zones: Zone[] }>('/api/zones').then((r) => r.zones), retry: false });
	const zones = !manual && zonesQ.data && zonesQ.data.length > 0 ? zonesQ.data : null;

	const add = useMutation({
		mutationFn: (domain: string) => api<AddDomainResult | PendingDomainResult>('/api/domains', { method: 'POST', body: { domain } }),
		onSuccess: async (res) => {
			// 202: ownership has to be proven first; nothing is monitored yet.
			if ('pending' in res && res.pending) setPending(res);
			else setResult(res as AddDomainResult);
			await qc.invalidateQueries({ queryKey: ['domains'] });
		},
	});

	if (result) return <SetupStep result={result} />;
	if (pending) {
		return (
			<div className="max-w-2xl space-y-6">
				<PageHeader title="Verify you own this domain" description="One DNS record and we can start. Nothing is monitored until it is verified." />
				<ClaimCard claim={pending.claim} onVerified={(d) => setResult({ domain: d, rua_hint: '' })} onRemoved={() => { setPending(null); setInput(''); }} />
				<p className="text-sm text-ink-2">
					You can leave this page: the domain stays under “Waiting for verification” on the <Link className="text-brand-ink underline underline-offset-4" to="/">Domains</Link> page.
				</p>
			</div>
		);
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		const domain = normalizeDomain(input);
		if (domain) add.mutate(domain);
	}

	return (
		<div className="max-w-2xl space-y-6">
			<PageHeader
				eyebrow={
					<Link to="/" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
						<ArrowLeft aria-hidden className="size-4" />
						Back
					</Link>
				}
				title="Add a domain"
				description="Enter the domain you send email from. We check its current security settings and guide you through the setup."
			/>
			<ReadOnlyNotice />
			<form onSubmit={submit} className="space-y-4" noValidate>
				<div className="space-y-1.5">
					<Label htmlFor="domain-input">Your domain</Label>
					{zonesQ.isPending ? (
						<Skeleton className="h-10 w-full" />
					) : zones ? (
						<>
							<Select value={input || undefined} onValueChange={setInput}>
								<SelectTrigger id="domain-input" aria-label="Domain from your Cloudflare account">
									<SelectValue placeholder="Select a domain from your Cloudflare account" />
								</SelectTrigger>
								<SelectContent>
									{zones.map((z) => (
										<SelectItem key={z.id} value={z.name}>
											{z.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FieldHint>
								Not listed?{' '}
								<button type="button" className="text-brand-ink underline underline-offset-4" onClick={() => { setManual(true); setInput(''); }}>
									Enter manually
								</button>
							</FieldHint>
						</>
					) : (
						<Input id="domain-input" placeholder="yourcompany.com" value={input} onChange={(e) => setInput(e.target.value)} autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={add.isError || undefined} aria-describedby={add.isError ? 'domain-error' : undefined} />
					)}
					{add.isError ? <FieldError id="domain-error">{errorMessage(add.error)}</FieldError> : null}
				</div>
				<WriteButton type="submit" loading={add.isPending} disabled={!normalizeDomain(input)}>
					{add.isPending ? 'Setting up…' : 'Continue'}
				</WriteButton>
			</form>

			<p className="text-sm text-ink-2">
				Adding many at once? <Link className="text-brand-ink underline underline-offset-4" to="/bulk-import">Import a list of domains</Link>, or{' '}
				<Link className="text-brand-ink underline underline-offset-4" to="/ct-discover">find subdomains from certificate logs</Link>.
			</p>

			<ul className="space-y-3 rounded-lg border border-line bg-surface-2 p-5 text-sm">
				<li>
					<strong>No impact on your email.</strong> We start in observation mode; nothing changes about how your email is delivered.
				</li>
				<li>
					<strong>Guided setup.</strong> We walk you through each step and can apply DNS changes automatically if your domain is on Cloudflare.
				</li>
				<li>
					<strong>Clear next steps.</strong> Once data starts coming in, the dashboard tells you exactly what to do and when it is safe.
				</li>
			</ul>
		</div>
	);
}
