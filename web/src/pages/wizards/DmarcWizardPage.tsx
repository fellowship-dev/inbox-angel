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
import { buildRecommendedRecord } from '../../lib/dmarc-record';
import { keys, useDomain } from '../../lib/queries';

type Policy = 'none' | 'quarantine' | 'reject';

const POLICY_STEPS: Record<Policy, number> = { none: 0, quarantine: 1, reject: 2 };
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
	if (domainsPending || dns.isPending) body = <PageSkeleton label="Reading your DMARC record" />;
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
	} else {
		const policy = (domain.dmarc_policy ?? 'none') as Policy;
		const current = step ?? POLICY_STEPS[policy];
		const enforced = policy === 'reject' || current >= 2;
		const copy = STEP_COPY[Math.min(current, 1)] ?? STEP_COPY[0];
		const cfManaged = dns.data.cf_managed;
		const currentRecord = appliedRecord ?? dns.data.current_record;
		const newRecord = buildRecommendedRecord(currentRecord, copy.target, domain.rua_address);

		body = (
			<>
				<WizardProgress
					label="Policy progress"
					current={Math.min(current, 2)}
					steps={[
						{ label: 'None', state: current > 0 ? 'complete' : 'pending' },
						{ label: 'Quarantine', state: current > 1 ? 'complete' : 'pending' },
						{ label: 'Reject', state: enforced ? 'complete' : 'pending' },
					]}
				/>
				{enforced ? (
					<StepCard title="Fully enforced">
						<p className="text-sm text-ink-2">
							DMARC is set to <strong className="text-ink-1">reject</strong>. Spoofed mail claiming to be from <strong className="text-ink-1">{domain.domain}</strong> is rejected
							outright by receiving servers.
						</p>
						<Alert variant="success">Nothing more to do here. Keep an eye on your pass rate in the domain overview.</Alert>
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
						<p className="text-sm text-ink-2">{copy.body}</p>
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
								current > 0 ? (
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
