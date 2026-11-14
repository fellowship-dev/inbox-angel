import { Alert, Button, CheckResult, CheckResultList, FieldHint } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice, WriteButton } from '../../components/states';
import { CopyButton } from '../../components/wizard/CopyButton';
import { TxtRecord } from '../../components/wizard/RecordPair';
import { StepCard } from '../../components/wizard/StepCard';
import { StepFooter } from '../../components/wizard/StepNav';
import { useRouteDomainId } from '../../components/wizard/useRouteDomainId';
import { WizardHeader } from '../../components/wizard/WizardHeader';
import { WizardProgress } from '../../components/wizard/WizardProgress';
import { api, errorMessage } from '../../lib/api';
import { buildRecommendedRecord, enforcementLevel, invalidDmarcSp, parseDmarcPolicy, weakerSubdomainPolicy } from '../../lib/dmarc-record';
import { keys, useDomain } from '../../lib/queries';
import { useOnboardingStatus } from '../../lib/domain-queries';
import { dmarcCoverage, inheritedSentence } from '../../lib/dmarc-coverage';
import { useReportsNotConnected } from '../../components/ReportsNotConnected';
import { HELP_PRIORITY, TalkToMax } from '../../components/TalkToMax';

type Policy = 'none' | 'quarantine' | 'reject';

const POLICY_STEPS: Record<Policy, number> = { none: 0, quarantine: 1, reject: 2 };

/**
 * The wizard step the live record has already reached. The stored policy can lag DNS (manual edits, a missed
 * refresh), so the live record decides; no record, or an unreadable p=, starts at none.
 */
function liveStep(record: string | null): number {
	const p = parseDmarcPolicy(record);
	return p === 'none' || p === 'quarantine' || p === 'reject' ? POLICY_STEPS[p] : 0;
}
const STEP_COPY = [
	{
		title: 'Step 1: switch to quarantine',
		body: 'Quarantine tells receiving servers to deliver suspicious mail to the spam folder instead of the inbox. Your legitimate mail is unaffected. Switch once your pass rate has been above 95% for a few days.',
		target: 'quarantine',
		variant: 'warning',
	},
	{
		title: 'Step 2: switch to reject',
		body: "Reject is full enforcement: spoofed mail claiming to be from your domain is rejected outright and never reaches recipients. Only switch when you've confirmed all your legitimate sending sources are passing.",
		target: 'reject',
		variant: 'info',
	},
] as const;

/**
 * Hosted, before report intake: no pass rate exists, so the steps say what DNS alone can and cannot confirm. Records
 * being published is checkable; every sender passing is not.
 */
const HOSTED_STEP_BODY = [
	'Quarantine tells receiving servers to put mail that fails DMARC in the spam folder. DNS shows that this domain publishes an SPF record and a DMARC record; it cannot show whether every service sending as this domain passes, because reports are not connected. Check each one (your mail provider, newsletter, invoicing and support tools) before you switch.',
	'Reject tells receiving servers to refuse mail that fails DMARC. DNS alone cannot show whether every service sending as this domain passes, because reports are not connected. Switch only once you have checked each sender yourself.',
] as const;

interface DnsCheck {
	found: boolean;
	has_rua: boolean;
	current_record: string | null;
	cf_managed: boolean;
	/** Set when the DNS lookup itself failed: the other fields are then unknown, not "absent". */
	error?: string;
}

export function DmarcWizardPage() {
	const domainId = useRouteDomainId();
	const qc = useQueryClient();
	const { domain, isPending: domainsPending, error: domainsError, refetch: refetchDomains } = useDomain(domainId);
	const dns = useQuery({ queryKey: ['dns-check', domainId], queryFn: () => api<DnsCheck>(`/api/domains/${domainId}/dns-check`), staleTime: 0, refetchOnMount: 'always' });

	const [step, setStep] = useState<number | null>(null);
	const hosted = useReportsNotConnected(domain);
	// SPF and what the name inherits: a policy is only tightened from a DMARC record of its own (and, hosted, with SPF published).
	const onboarding = useOnboardingStatus(domainId);
	const [appliedRecord, setAppliedRecord] = useState<string | null>(null);

	const apply = useMutation({
		mutationFn: ({ target }: { target: Policy; from: number }) => api<{ ok: boolean; policy: string; record: string }>(`/api/domains/${domainId}/dmarc`, { method: 'PATCH', body: { policy: target } }),
		onSuccess: async (res, { target, from }) => {
			await qc.invalidateQueries({ queryKey: keys.domains });
			setAppliedRecord(res.record || buildRecommendedRecord(appliedRecord ?? dns.data?.current_record ?? null, target, domain?.rua_address ?? ''));
			setStep(from + 1);
		},
	});

	const back = `/domains/${domainId}`;
	let body;
	const coverage = dmarcCoverage(onboarding.data ?? null, onboarding.isError);
	// Hosted: say only what DNS shows, and offer no tightening while SPF or DMARC is missing. Any mode: a name without a
	// record of its own that inherits a policy gets no offer, since a record of its own would replace (and could weaken) it.
	// A name DNS says does not exist has nothing to tighten, in any mode.
	const nxdomain = onboarding.data?.nxdomain === true;
	const notReady = !!domain && !!dns.data && !dns.data.error && (nxdomain || (hosted ? !dns.data.found || !onboarding.data?.spf.record : !dns.data.found && coverage.kind === 'inherited'));
	if (domainsPending || dns.isPending || (hosted && onboarding.isPending)) body = <PageSkeleton label="Reading your DMARC record" />;
	else if (domainsError) body = <LoadError error={domainsError} onRetry={() => void refetchDomains()} title="Could not load this domain" />;
	else if (!domain) {
		body = (
			<Alert variant="warning" title="Domain not found">
				This domain does not exist, or you no longer have access to it.
			</Alert>
		);
	} else if (dns.isError || dns.data.error) {
		// A failed lookup is not "no record": building a record from nothing would drop tags the real one carries.
		body = (
			<StepCard title="Current DMARC record">
				<CheckResultList>
					<CheckResult
						status="error"
						title={`DMARC for _dmarc.${domain.domain}`}
						summary={dns.isError ? errorMessage(dns.error) : `The DNS lookup failed (${dns.data.error}).`}
						onRetry={() => void dns.refetch()}
					/>
				</CheckResultList>
				<p className="text-sm text-ink-2">We need to read your current record before suggesting the next policy, so nothing is offered until the lookup works.</p>
			</StepCard>
		);
	} else if (notReady) {
		const spf = onboarding.data?.spf.record;
		body = (
			<StepCard title="Not ready to change the policy">
				<ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
					<li>
						{nxdomain
							? `DNS says ${domain.domain} does not exist, so there are no records to change.`
							: dns.data.found
							? 'A DMARC record is published.'
							: coverage.kind === 'inherited'
								? inheritedSentence(domain.domain, coverage)
								: `No DMARC record at _dmarc.${domain.domain}.`}
					</li>
					{hosted && !nxdomain ? <li>{onboarding.isError ? 'We could not read the SPF record.' : spf ? 'An SPF record is published.' : `No SPF record at ${domain.domain}.`}</li> : null}
				</ul>
				<p className="text-sm text-ink-2">
					{nxdomain
						? 'Check the spelling, or register the domain.'
						: dns.data.found || coverage.kind !== 'inherited'
						? 'Tightening the policy starts from a published SPF record and a DMARC record of its own, so nothing is offered here yet.'
						: 'Nothing is offered here: change the policy at the parent domain, or publish a record of its own that is at least as strict.'}
				</p>
				<TalkToMax priority={HELP_PRIORITY.tightening} lead="Not sure what to publish?" about={`about ${domain.domain}`} />
				<StepFooter
					end={
						<Button asChild>
							<Link to={back}>Back to domain</Link>
						</Button>
					}
				/>
			</StepCard>
		);
	} else {
		// Never below the live policy: the wizard must not offer a record weaker than the one already published.
		const floor = liveStep(dns.data.found ? dns.data.current_record : null);
		const current = Math.max(step ?? floor, floor);
		const enforced = current >= 2;
		const copy = STEP_COPY[Math.min(current, 1)] ?? STEP_COPY[0];
		const stepBody = hosted ? HOSTED_STEP_BODY[Math.min(current, 1)] : copy.body;
		const cfManaged = dns.data.cf_managed;
		const currentRecord = appliedRecord ?? dns.data.current_record;
		const newRecord = buildRecommendedRecord(currentRecord, copy.target, domain.rua_address);
		// p=reject with pct below 100 applies to that share of mail only: that is not full enforcement.
		const partial = enforced ? enforcementLevel(currentRecord) : null;
		const partialPct = partial?.level === 'partial' ? partial.pct : null;
		// sp= weaker than p= leaves subdomains without their own record less enforced than the domain itself.
		const spWeaker = enforced ? weakerSubdomainPolicy(currentRecord) : null;
		const spInvalid = enforced ? invalidDmarcSp(currentRecord) : null;
		const spNotes = (
			<>
				{spWeaker ? (
					<Alert variant="warning">
						Subdomains follow <strong>sp={spWeaker}</strong>, not p=reject, so mail from a subdomain without its own record is not rejected. Set sp=reject to enforce it there too.
					</Alert>
				) : null}
				{spInvalid ? (
					<Alert variant="warning">
						The record has sp={spInvalid}, which is not a valid policy, so it is ignored and subdomains inherit p=reject.
					</Alert>
				) : null}
			</>
		);

		body = (
			<>
				<WizardProgress
					label="Policy progress"
					current={Math.min(current, 2)}
					steps={[
						{ label: 'None', state: current > 0 ? 'complete' : 'pending' },
						{ label: 'Quarantine', state: current > 1 ? 'complete' : 'pending' },
						{ label: 'Reject', state: enforced && partialPct === null ? 'complete' : 'pending' },
					]}
				/>
				{enforced ? (
					<StepCard title={partialPct !== null ? `Partially enforced: ${partialPct}%` : spWeaker ? 'Enforced on this domain; subdomains are not' : 'Fully enforced'}>
						{partialPct !== null ? (
							<>
								<p className="text-sm text-ink-2">
									DMARC is set to <strong className="text-ink-1">reject</strong> with <strong className="text-ink-1">pct={partialPct}</strong>, so it applies to only {partialPct}% of mail
									failing for <strong className="text-ink-1">{domain.domain}</strong>. Receivers handle the rest one policy level weaker.
								</p>
								{currentRecord ? <TxtRecord title="Current record" name="_dmarc" value={currentRecord} /> : null}
								<Alert variant="warning">To enforce all of it, raise pct= to 100 (or remove it) at your DNS provider once your failing sources are fixed.</Alert>
								{spNotes}
							</>
						) : (
							<>
								<p className="text-sm text-ink-2">
									DMARC is set to <strong className="text-ink-1">reject</strong>. Spoofed mail claiming to be from <strong className="text-ink-1">{domain.domain}</strong> is rejected
									outright by receiving servers.
								</p>
								{spNotes}
								{spWeaker ? (
									<Alert variant="info">One thing left: set sp=reject at your DNS provider so subdomains are rejected too.{hosted ? '' : ' Keep an eye on your pass rate in the domain overview.'}</Alert>
								) : (
									<Alert variant="success">{hosted ? 'Nothing more to do here.' : 'Nothing more to do here. Keep an eye on your pass rate in the domain overview.'}</Alert>
								)}
							</>
						)}
						<StepFooter
							end={
								<Button asChild>
									<Link to={back}>Back to domain</Link>
								</Button>
							}
						/>
					</StepCard>
				) : (
					<StepCard title={copy.title}>
						<p className="text-sm text-ink-2">{stepBody}</p>
						{hosted ? <TalkToMax priority={HELP_PRIORITY.tightening} lead="Not sure every sender passes?" about="before you tighten the policy" /> : null}
						{currentRecord ? <TxtRecord title="Current record" name="_dmarc" value={currentRecord} /> : null}
						<TxtRecord title="New record" name="_dmarc" value={newRecord} />
						{apply.isError ? (
							<Alert variant="danger" title="Could not apply the policy">
								{errorMessage(apply.error)}
							</Alert>
						) : null}
						{!cfManaged ? (
							<Alert variant="info" title="This does not change your DNS">
								Inbox Angel cannot edit this domain's DNS. Copy the new record into your DNS provider, then confirm. Confirming makes no change on our side: Inbox Angel will detect
								the new policy from your DNS on its own.
							</Alert>
						) : null}
						<StepFooter
							start={
								current > floor ? (
									<Button variant="ghost" onClick={() => setStep(current - 1)} disabled={apply.isPending}>
										Back
									</Button>
								) : undefined
							}
							end={
								<>
									{!cfManaged ? <CopyButton text={newRecord} /> : null}
									{cfManaged ? (
										<WriteButton loading={apply.isPending} onClick={() => apply.mutate({ target: copy.target, from: current })}>
											{apply.isPending ? 'Applying…' : 'Apply via Cloudflare'}
										</WriteButton>
									) : (
										<Button onClick={() => setStep(current + 1)}>I've updated it manually</Button>
									)}
								</>
							}
						/>
						{!cfManaged ? <FieldHint>Copy the record above and update it at your DNS provider, then confirm.</FieldHint> : null}
					</StepCard>
				)}
			</>
		);
	}

	return (
		<div className="space-y-6">
			<WizardHeader backTo={back} title="DMARC policy graduation" subtitle="Guided path: none, then quarantine, then reject." />
			<ReadOnlyNotice />
			{body}
		</div>
	);
}
