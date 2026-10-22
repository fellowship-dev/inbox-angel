import { Alert, Badge, Button, CheckResult, CheckResultList } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice, WriteButton } from '../../components/states';
import { CopyButton } from '../../components/wizard/CopyButton';
import { LookupBadge, RecordPair, TxtRecord } from '../../components/wizard/RecordPair';
import { StepCard } from '../../components/wizard/StepCard';
import { StepFooter, StepNav } from '../../components/wizard/StepNav';
import { WizardHeader } from '../../components/wizard/WizardHeader';
import { WizardProgress } from '../../components/wizard/WizardProgress';
import { api, errorMessage } from '../../lib/api';
import type { OnboardingStatus, SpfFlatConfig, SpfFlatStatus } from '../../lib/types';
import { useRouteDomainId } from '../../components/wizard/useRouteDomainId';
import { dnsErrorDetail, dnsErrorsFor } from './setup/steps';

const STEPS = ['Analyze', 'Compare', 'Enable', 'Done'] as const;

interface FlattenData {
	flat: SpfFlatStatus;
	/** The record being flattened: the stored original if flattening ran before, otherwise what DNS says now. */
	record: string | null;
	/** Set when the live SPF lookup failed: `record` is then unknown, not absent. */
	recordError: string | null;
	lookupCount: number | null;
	preview: string | null;
	previewFailed: boolean;
}

async function loadFlatten(domainId: number): Promise<FlattenData> {
	const flat = await api<SpfFlatStatus>(`/api/domains/${domainId}/spf-flatten`);
	let record = flat.config?.canonical_record ?? null;
	let recordError: string | null = null;
	if (!record) {
		const obs = await api<OnboardingStatus>(`/api/domains/${domainId}/onboarding-status`);
		record = obs.spf.record;
		const failed = dnsErrorsFor(obs, 'spf');
		if (!record && failed.length > 0) recordError = dnsErrorDetail(failed[0] ?? '');
	}
	let lookupCount = flat.lookup_count ?? flat.config?.lookup_count ?? null;
	if (record && lookupCount === null) {
		lookupCount = await api<{ lookup_count: number }>('/api/spf-lookup-count', { body: { record } })
			.then((r) => r.lookup_count)
			.catch(() => null);
	}
	let preview = flat.config?.flattened_record ?? null;
	let previewFailed = false;
	if (!preview && record) {
		// Degraded, not blocking: the record is generated when flattening is enabled anyway.
		try {
			preview = (await api<{ flattened_record: string; ip_count: number }>(`/api/domains/${domainId}/spf-flatten/preview`)).flattened_record;
		} catch {
			previewFailed = true;
		}
	}
	return { flat, record, recordError, lookupCount, preview, previewFailed };
}

export function SpfFlattenPage() {
	const domainId = useRouteDomainId();
	const qc = useQueryClient();
	const queryKey = ['spf-flatten-wizard', domainId] as const;
	const q = useQuery({ queryKey, queryFn: () => loadFlatten(domainId), staleTime: 0, refetchOnMount: 'always' });
	const [step, setStep] = useState(0);

	const enable = useMutation({
		mutationFn: () => api<{ ok: boolean; config: SpfFlatConfig }>(`/api/domains/${domainId}/spf-flatten`, { method: 'POST' }),
		onSuccess: ({ config }) => {
			qc.setQueryData<FlattenData>(queryKey, (d) =>
				d ? { ...d, flat: { ...d.flat, available: true, config }, preview: config.flattened_record ?? d.preview } : d,
			);
			void qc.invalidateQueries({ queryKey: ['domains'] });
			setStep(3);
		},
	});

	const back = `/domains/${domainId}`;
	let body;
	if (q.isPending) body = <PageSkeleton label="Reading your SPF record" />;
	else if (q.isError) body = <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load SPF flattening" />;
	else {
		const { flat, record, recordError, lookupCount, preview, previewFailed } = q.data;
		const config = flat.config;
		const active = !!config?.enabled;
		const ipCount = config?.ip_count;
		const flattened = config?.flattened_record ?? preview;

		body = (
			<>
				<WizardProgress label="Flattening progress" current={step} steps={STEPS.map((label, i) => ({ label, state: i < step ? 'complete' : 'pending' }))} />

				{step === 0 ? (
					<StepCard title="Analyze your SPF record">
						{recordError ? (
							<CheckResultList>
								<CheckResult status="error" title="SPF record" summary={`The DNS lookup failed (${recordError}).`} onRetry={() => void q.refetch()} />
							</CheckResultList>
						) : record ? (
							<>
								<TxtRecord title="Your current SPF record" value={record} />
								{lookupCount !== null ? (
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<span className="text-ink-2">DNS lookups:</span>
										<LookupBadge count={lookupCount} suffix="used" />
									</div>
								) : null}
								{lookupCount !== null && lookupCount <= 7 ? (
									<Alert variant="info">Your SPF record is within safe limits. Flattening is optional but still available.</Alert>
								) : null}
							</>
						) : (
							<Alert variant="warning" title="No SPF record found">
								Flattening needs an SPF record to work from. Add one in the setup wizard first.
							</Alert>
						)}
						{active ? (
							<Alert variant="success" title="SPF flattening is already active">
								{ipCount ?? '?'} IPs in the flattened record.
							</Alert>
						) : null}
						<StepFooter
							end={
								record ? (
									<Button onClick={() => setStep(1)}>Continue</Button>
								) : (
									<Button asChild variant={recordError ? 'secondary' : 'primary'}>
										<Link to={back}>Back to domain</Link>
									</Button>
								)
							}
						/>
					</StepCard>
				) : null}

				{step === 1 ? (
					<StepCard title="Compare: original and flattened">
						<p className="text-sm text-ink-2">
							Flattening resolves every <code className="font-mono text-ink-1">include:</code> to raw IP addresses, which brings the lookup count down to 1. The flattened record is
							re-resolved daily to follow your providers' changes.
						</p>
						<RecordPair>
							<TxtRecord title="Original record" value={record ?? ''} badge={lookupCount !== null ? <LookupBadge count={lookupCount} /> : undefined} />
							{flattened ? (
								<TxtRecord title="Flattened record" value={flattened} badge={<Badge variant="success">1 lookup</Badge>} />
							) : (
								<div className="space-y-1.5">
									<p className="text-sm font-medium text-ink-1">Flattened record</p>
									<Alert variant="warning" title={previewFailed ? 'Preview unavailable' : 'No preview yet'}>
										Could not resolve the IPs, so DNS may be unreachable. The record is generated when flattening is enabled.
									</Alert>
								</div>
							)}
						</RecordPair>
						<StepNav onNext={() => setStep(2)} onBack={() => setStep(0)} showSkip={false} />
					</StepCard>
				) : null}

				{step === 2 ? (
					<StepCard title="Enable SPF flattening">
						{active ? (
							<Alert variant="success" title="SPF flattening is already active" />
						) : (
							<>
								<Alert variant="warning" title="This changes your live DNS">
									Enabling <strong>immediately replaces</strong> your SPF TXT record in Cloudflare DNS with the flattened version. Your current record is stored and restored if you
									disable flattening.
								</Alert>
								<p className="text-sm text-ink-2">
									The flattened record is <strong className="text-ink-1">re-resolved daily</strong>, so if your mail providers add or change IPs the record updates itself.
								</p>
								{record ? <TxtRecord title="Record to flatten" value={record} /> : null}
								{!flat.available ? (
									<Alert variant="warning" title="Not available here">
										SPF flattening writes to Cloudflare DNS, and no Cloudflare connection is configured.
									</Alert>
								) : null}
							</>
						)}
						{enable.isError ? (
							<Alert variant="danger" title="Could not enable SPF flattening">
								{errorMessage(enable.error)}
							</Alert>
						) : null}
						<StepFooter
							start={
								<Button variant="ghost" onClick={() => setStep(1)}>
									Back
								</Button>
							}
							end={
								active ? (
									<Button onClick={() => setStep(3)}>Continue</Button>
								) : (
									<WriteButton loading={enable.isPending} disabled={!flat.available || !record} onClick={() => enable.mutate()}>
										{enable.isPending ? 'Enabling…' : 'Enable SPF flattening'}
									</WriteButton>
								)
							}
						/>
					</StepCard>
				) : null}

				{step === 3 ? (
					<StepCard title="SPF flattening enabled">
						<Alert variant="success" title="Your SPF record has been flattened">
							<ul className="list-disc space-y-0.5 pl-5">
								{ipCount ? <li>{ipCount} IPs in the flattened record</li> : null}
								<li>DNS lookups reduced to 1</li>
								<li>IPs are re-resolved daily to follow upstream provider changes</li>
							</ul>
						</Alert>
						{config?.flattened_record ? (
							<div className="space-y-2">
								<TxtRecord title="Published record" value={config.flattened_record} />
								<CopyButton text={config.flattened_record} />
							</div>
						) : null}
						<StepFooter
							end={
								<Button asChild>
									<Link to={back}>Back to domain</Link>
								</Button>
							}
						/>
					</StepCard>
				) : null}
			</>
		);
	}

	return (
		<div className="space-y-6">
			<WizardHeader backTo={back} title="SPF flattening" subtitle="Cut the lookups in your SPF record to stay under the limit of 10." />
			<ReadOnlyNotice />
			{body}
		</div>
	);
}
