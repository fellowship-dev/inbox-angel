import { Alert, Badge, Button, CheckResult, CheckResultList, FieldError, FieldHint, Input, Label, PageHeader, RecordBlock, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@ready-set-mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ClaimCard } from '../../components/domain/ClaimCard';
import { InheritanceBanner } from '../../components/domain/InheritanceBanner';
import { PlanLimitNotice, planLimitOf } from '../../components/PlanLimitNotice';
import { ReadOnlyNotice, WriteButton } from '../../components/states';
import { DomainRefusalHelp } from '../../components/TalkToMax';
import { ReportsNotConnected } from '../../components/ReportsNotConnected';
import { api, errorMessage } from '../../lib/api';
import { useHosted } from '../../lib/session';
import { normalizeDomain } from '../../lib/dmarc';
import { buildRecommendedRecord, hasReportAddress, parseDmarcPolicy } from '../../lib/dmarc-record';
import { domainKeys, useOnboardingStatus, type DnsCheck } from '../../lib/domain-queries';
import { dmarcCoverage, inheritedSentence, keptEnforcement, offerEnforcement, recordFor } from '../../lib/dmarc-coverage';
import { clearSignupDomainIf, readSignupDomain } from '../../lib/signup-intent';
import type { AddDomainResult, PendingDomainResult } from '../../lib/types';

const POLL_MS = 15_000;

interface Zone {
	id: string;
	name: string;
	status: string;
}

/**
 * Checks right away, then every 15 s until the record (with our rua) is seen. Without a reports address there is no rua
 * to wait for, so it checks once. A failed lookup keeps polling (when polling) and is never "not found".
 */
function useLiveDnsCheck(domainId: number, rua: string | null | undefined) {
	const watching = hasReportAddress(rua);
	return useQuery({
		queryKey: domainKeys.dnsCheck(domainId),
		queryFn: () => api<DnsCheck>(`/api/domains/${domainId}/dns-check`),
		staleTime: 0,
		retry: false,
		refetchInterval: (query) => (!watching || (query.state.data?.found && query.state.data.has_rua && !query.state.data.error) ? false : POLL_MS),
	});
}

function LiveDnsCheck({ q, rua }: { q: ReturnType<typeof useLiveDnsCheck>; rua: string | null | undefined }) {
	const title = 'Your DMARC record';
	const watching = hasReportAddress(rua);

	let row;
	if (q.isPending) {
		row = (
			<li aria-busy="true" className="rounded-lg border border-line p-4">
				<Skeleton className="h-5 w-1/2" />
				<span className="sr-only">Checking for your DNS record…</span>
			</li>
		);
	} else if (q.isError || q.data.error) {
		row = <CheckResult status="error" title={title} summary={watching ? 'Could not check DNS just now. We keep trying every 15 seconds.' : 'Could not check DNS just now.'} onRetry={() => void q.refetch()} />;
	} else if (q.data.found && q.data.has_rua) {
		row = <CheckResult status="pass" title={title} statusLabel="Detected" summary="DNS record detected! Reports will start arriving within 24 hours." />;
	} else if (q.data.found) {
		row = (
			<CheckResult status="warn" title={title} statusLabel={watching ? 'Missing rua' : 'No reports address'} summary={watching ? 'TXT record found, but the rua= address is missing. Double-check you copied the full value above.' : 'TXT record found. No reports address is configured for this domain, so there is no rua= to look for.'}>
				{watching ? (
					<>
						Expected: <code className="font-mono">rua=mailto:{rua.trim()}</code>
					</>
				) : null}
			</CheckResult>
		);
	} else if (!watching) {
		row = <CheckResult status="missing" title={title} summary="No DMARC record found. With no reports address configured there is nothing to add yet, so we are not checking again." />;
	} else {
		row = <CheckResult status="missing" title={title} summary="DNS record not detected yet. We check every 15 seconds; DNS changes can take a few minutes to propagate." />;
	}
	return <CheckResultList aria-live="polite">{row}</CheckResultList>;
}

function SetupStep({ result }: { result: AddDomainResult }) {
	const { domain } = result;
	const hosted = useHosted();
	if (hosted && !hasReportAddress(domain.rua_address)) return <HostedVerified domain={domain} resumed={result.resumed} />;
	return <SelfHostSetupStep result={result} />;
}

/**
 * Hosted, before report intake: the domain is in, but there is no report address, so there is no rua= record to add.
 * Point to what works now (the live DNS checks in the setup wizard) and say plainly that reports are not connected.
 */
function HostedVerified({ domain, resumed = false }: { domain: AddDomainResult['domain']; resumed?: boolean }) {
	return (
		<div className="max-w-2xl space-y-6">
			<PageHeader
				title={`${domain.domain} is in your workspace`}
				description="Its SPF, DKIM and DMARC records are checked from live DNS. Setup walks through each one and shows the exact record to publish where something is missing."
				eyebrow={
					<Badge variant="success">
						<CheckCircle2 aria-hidden />
						{resumed ? 'Already verified' : 'Ownership verified'}
					</Badge>
				}
			/>
			<ReportsNotConnected domain={domain.domain} domainId={domain.id} />
			<div className="flex flex-col gap-2 sm:flex-row">
				<Button asChild>
					<Link to={`/domains/${domain.id}/setup`}>Check its records</Link>
				</Button>
				<Button asChild variant="secondary">
					<Link to={`/domains/${domain.id}`}>Go to {domain.domain}</Link>
				</Button>
			</div>
		</div>
	);
}

function SelfHostSetupStep({ result }: { result: AddDomainResult }) {
	const { domain } = result;
	const rua = hasReportAddress(domain.rua_address) ? domain.rua_address.trim() : null;
	const q = useLiveDnsCheck(domain.id, domain.rua_address);
	// What the name inherits when it has no record of its own (a subdomain under an enforcing parent).
	const ob = useOnboardingStatus(domain.id);
	const coverage = dmarcCoverage(ob.data ?? null, ob.isError || (ob.data?.dns_errors ?? []).some((e) => e.startsWith('dmarc:')));
	const lookup = q.isPending || (!q.data?.found && ob.isPending) ? 'reading' : q.isError || q.data.error ? 'failed' : 'done';
	// The live record decides what is offered: it is built from, and never to a weaker policy than, the one published.
	const live = lookup === 'done' && q.data?.found ? q.data.current_record : null;
	const livePolicy = parseDmarcPolicy(live);
	// No record of its own: the new one replaces what it inherits, so it starts at the inherited policy when that enforces.
	const floor = live ? { policy: 'none' as const, pct: 100 } : offerEnforcement(coverage);
	// DNS says the name does not exist: there is no record to add anywhere.
	const nxdomain = ob.data?.nxdomain === true;
	const record = rua && lookup === 'done' && floor && !nxdomain ? (live ? buildRecommendedRecord(live, livePolicy ?? 'none', rua) : recordFor(floor, rua)) : null;
	const inPlace = lookup === 'done' && !!q.data?.found && !!q.data.has_rua;
	const offered = record !== null && !inPlace;

	let heading: { title: string; description: string };
	if (!rua) heading = { title: 'Reports address needed', description: `${domain.domain} is added, but it has no reports address yet, so there is no DNS record to add.` };
	else if (lookup === 'reading') heading = { title: 'Reading your DMARC record', description: `Reading the current DMARC record for ${domain.domain}…` };
	else if (nxdomain) heading = { title: 'This domain does not resolve', description: `DNS says ${domain.domain} does not exist, so there is no DMARC record to add. Check the spelling, or register the domain.` };
	else if (lookup === 'failed') heading = { title: 'Could not read your DMARC record', description: `We could not read the current DMARC record for ${domain.domain}, so no record is offered until the lookup works.` };
	else if (inPlace) heading = { title: 'Your DNS record is in place', description: `The DMARC record for ${domain.domain} already sends reports here.` };
	else if (live) heading = { title: 'Update your DMARC record', description: `${domain.domain} already has a DMARC record. Replace it with this one: it keeps your settings and adds our reports address.` };
	else if (!floor) heading = { title: 'Could not tell which DMARC policy applies', description: `We could not tell whether a parent domain's policy covers ${domain.domain}, so no record is offered until the lookup works.` };
	else if (coverage.kind === 'inherited') heading = { title: 'Add this DNS record', description: `${inheritedSentence(domain.domain, coverage)} To receive reports here, add this TXT record: it keeps ${floor ? keptEnforcement(coverage, floor) : ''} and adds our reports address.` };
	else heading = { title: 'Add this DNS record', description: `Log in to wherever you manage ${domain.domain} (GoDaddy, Namecheap, Cloudflare, Route 53 …) and add this TXT record.` };

	return (
		<div className="max-w-2xl space-y-6">
			<PageHeader
				title={heading.title}
				description={heading.description}
				eyebrow={
					<Badge variant="success">
						<CheckCircle2 aria-hidden />
						Domain added
					</Badge>
				}
			/>
			{result.parent_context ? <InheritanceBanner pc={result.parent_context} subdomain={domain.domain} /> : null}
			{!rua ? (
				<Alert variant="warning" title="Report address not configured yet">
					This domain has no Ready Set Mail report address, so there is no record to copy yet. A DMARC record needs one to send reports here.
				</Alert>
			) : null}
			{lookup === 'reading' && rua ? <Skeleton className="h-24 w-full" /> : null}
			{offered ? (
				<RecordBlock title="DMARC record" record={{ type: 'TXT', name: `_dmarc.${domain.domain}`, value: record, ttl: '3600 (or your provider default)' }} />
			) : null}
			{offered && !live && floor?.policy === 'none' ? (
				<p className="text-sm text-ink-2">
					<strong className="text-ink-1">p=none</strong> means you are just watching. No email gets blocked or redirected. Once DMARC reports start coming in (usually within 24 hours), the dashboard shows whether your mail is fully aligned and when it is safe to enforce.
				</p>
			) : null}
			{offered && live ? (
				<p className="text-sm text-ink-2">
					Your policy stays <strong className="text-ink-1">p={livePolicy ?? 'as published'}</strong>: only the reports address is added, so nothing about how your mail is handled changes.
				</p>
			) : null}
			{/* The authorization record goes with a DMARC record: when none is offered (unknown policy, no such name), none is required. */}
			{result.manual_dns && result.dns_instructions && (offered || inPlace || !!live) ? (
				<Alert variant="warning" title="Also add">
					{result.dns_instructions}
				</Alert>
			) : null}
			{nxdomain ? null : <LiveDnsCheck q={q} rua={domain.rua_address} />}
			<Button asChild>
				<Link to={`/domains/${domain.id}`}>Go to {domain.domain}</Link>
			</Button>
		</div>
	);
}

export function AddDomainPage() {
	const qc = useQueryClient();
	// The domain asked for on the website, if any: a prefill the person confirms with Continue.
	const [input, setInput] = useState(() => readSignupDomain() ?? '');
	const [manual, setManual] = useState(false);
	const [result, setResult] = useState<AddDomainResult | null>(null);
	const [pending, setPending] = useState<PendingDomainResult | null>(null);

	// A missing Cloudflare token (400) or any failure just means "type it in".
	const zonesQ = useQuery({ queryKey: domainKeys.zones, queryFn: () => api<{ zones: Zone[] }>('/api/zones').then((r) => r.zones), retry: false });
	// A prefilled domain that is not one of the listed zones is typed, not picked.
	const zones = !manual && zonesQ.data && zonesQ.data.length > 0 && (input === '' || zonesQ.data.some((z) => z.name === input)) ? zonesQ.data : null;

	const add = useMutation({
		mutationFn: (domain: string) => api<AddDomainResult | PendingDomainResult>('/api/domains', { method: 'POST', body: { domain } }),
		onSuccess: async (res, domain) => {
			clearSignupDomainIf(domain);
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
				<ClaimCard claim={pending.claim} preview onVerified={(d, { resumed }) => setResult({ domain: d, rua_hint: '', resumed })} onRemoved={() => { setPending(null); setInput(''); }} />
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
						<Input id="domain-input" placeholder="yourcompany.com" value={input} onChange={(e) => setInput(e.target.value)} autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={(add.isError && !planLimitOf(add.error)) || undefined} aria-describedby={add.isError && !planLimitOf(add.error) ? 'domain-error' : undefined} />
					)}
					{add.isError && !planLimitOf(add.error) ? <FieldError id="domain-error">{errorMessage(add.error)}</FieldError> : null}
					{add.isError && !planLimitOf(add.error) ? <DomainRefusalHelp error={add.error} /> : null}
					{add.isError && planLimitOf(add.error) ? <PlanLimitNotice limit={planLimitOf(add.error)!} /> : null}
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
