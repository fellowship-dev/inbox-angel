import { Alert, Badge, Button, CheckResult, CheckResultList, FieldHint, IconButton, toast } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { WriteButton } from '../../../components/states';
import { CopyButton } from '../../../components/wizard/CopyButton';
import { LookupBadge, RecordPair, TxtRecord } from '../../../components/wizard/RecordPair';
import { SeverityBadge } from '../../../components/wizard/SeverityBadge';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter, StepNav } from '../../../components/wizard/StepNav';
import { api, errorMessage } from '../../../lib/api';
import { SPF_PROVIDERS, detectProviders } from '../../../lib/email-service-providers';
import { buildSpfRecord, existingQualifier, extractIncludes, extractOtherMechanisms, type SpfQualifier } from '../../../lib/spf';
import type { OnboardingStatus } from '../../../lib/types';
import { RadioCard } from '../../../components/wizard/RadioCard';
import { useDebouncedValue, setupKeys } from './hooks';
import { ProviderPicker } from './ProviderPicker';
import { SpfOverwriteDialog, type SpfOverwrite } from './SpfOverwriteDialog';
import { dnsErrorDetail, dnsErrorsFor, spfSeverity } from './steps';

export interface StepProps {
	status: OnboardingStatus;
	onNext: () => void;
	onSkip: () => void;
	/** Re-run the DNS checks (GET onboarding-status). */
	onRetry: () => void;
	/** A re-run of the DNS checks is in flight. */
	retrying?: boolean;
}

interface ApplySpfResponse {
	ok: boolean;
	needs_confirmation?: boolean;
	existing_record?: string;
	proposed_record?: string;
}

const providerName = (include: string) => SPF_PROVIDERS.find((p) => p.include === include)?.name ?? include;

export function SpfStep(props: StepProps) {
	const { status, onNext, onSkip, onRetry } = props;
	const failed = dnsErrorsFor(status, 'spf');
	if (failed.length > 0) {
		// Not a missing record: we could not read it. No editor, no "apply" nudge, until a lookup succeeds.
		return (
			<StepCard title="SPF record" badge={<SeverityBadge severity="unknown" />}>
				<CheckResultList>
					<CheckResult
						status="error"
						title={`SPF for ${status.domain}`}
						summary={`The DNS lookup failed (${dnsErrorDetail(failed[0] ?? '')}).`}
						onRetry={onRetry}
					/>
				</CheckResultList>
				<p className="text-sm text-ink-2">Until the lookup works we cannot tell what your SPF record says, so we will not suggest changes. You can continue and come back.</p>
				<StepNav onNext={onNext} onSkip={onSkip} />
			</StepCard>
		);
	}
	if (status.spf.flattening_active) {
		return (
			<StepCard title="SPF record" badge={<SeverityBadge severity="info" />}>
				{status.spf.record ? <TxtRecord title="Current record" value={status.spf.record} /> : null}
				<Alert variant="info" title="SPF flattening is active">
					Editing is disabled because the next flattening run would overwrite your changes. Disable flattening on the domain page to edit the record by hand.
				</Alert>
				<StepNav onNext={onNext} onSkip={onSkip} showSkip={false} />
			</StepCard>
		);
	}
	return <SpfEditor {...props} />;
}

function SpfEditor({ status, onNext, onSkip }: StepProps) {
	const qc = useQueryClient();
	const { spf, cf_available } = status;
	const existingIncludes = spf.record ? extractIncludes(spf.record) : [];
	const detectedKnown = new Set((spf.record ? detectProviders(spf.record) : []).map((p) => p.include));
	const otherMechanisms = spf.record ? extractOtherMechanisms(spf.record) : [];

	const [selected, setSelected] = useState<string[]>(() => [...new Set(existingIncludes)]);
	const [qualifier, setQualifier] = useState<SpfQualifier>(() => existingQualifier(spf.record));
	const [applied, setApplied] = useState(false);
	const [overwrite, setOverwrite] = useState<(SpfOverwrite & { record: string }) | null>(null);

	const preview = selected.length > 0 || otherMechanisms.length > 0 ? buildSpfRecord(selected, qualifier, otherMechanisms) : null;
	const hasChanges = preview !== spf.record;

	// The real count walks nested includes server-side; wait for typing to settle, and skip the call when the record is unchanged.
	const debounced = useDebouncedValue(preview, 400);
	const unchanged = preview !== null && preview === spf.record && spf.lookup_count !== null;
	const countQ = useQuery({
		queryKey: ['spf-lookup-count', debounced],
		queryFn: () => api<{ lookup_count: number }>('/api/spf-lookup-count', { body: { record: debounced } }),
		enabled: debounced !== null && !unchanged,
		retry: false,
		staleTime: Infinity,
	});
	const counting = !unchanged && preview !== null && (preview !== debounced || countQ.isFetching);
	const realCount = unchanged ? spf.lookup_count : preview === debounced ? (countQ.data?.lookup_count ?? null) : null;
	const lookupCount = realCount ?? selected.length;

	const apply = useMutation({
		mutationFn: ({ record, confirm }: { record: string; confirm: boolean }) =>
			api<ApplySpfResponse>(`/api/domains/${status.domain_id}/apply-spf`, { body: { record, confirm_overwrite: confirm } }),
		onSuccess: (res, vars) => {
			if (res.needs_confirmation) {
				setOverwrite({ existing: res.existing_record ?? '', proposed: res.proposed_record ?? vars.record, record: vars.record });
				return;
			}
			setOverwrite(null);
			setApplied(true);
			toast({ variant: 'success', title: 'SPF record applied', description: 'Allow a few minutes for DNS propagation.' });
			qc.setQueryData<OnboardingStatus>(setupKeys.status(status.domain_id), (s) =>
				s ? { ...s, spf: { ...s.spf, record: vars.record, lookup_count: realCount ?? s.spf.lookup_count } } : s,
			);
		},
	});

	const severity = applied ? 'info' : spfSeverity(spf);
	const showCompare = spf.record !== null && hasChanges && preview !== null;
	const removeAll = preview === null && spf.record !== null;

	return (
		<StepCard title="SPF record" badge={<SeverityBadge severity={severity} />}>
			{applied ? (
				<Alert variant="success" title="SPF record applied">
					Allow a few minutes for DNS propagation.
				</Alert>
			) : (
				<p className="text-sm text-ink-2">
					{spf.record
						? 'SPF tells receiving mail servers which services may send email for your domain. Pick the providers you use; we pre-selected what we found in your current record.'
						: 'No SPF record found. Without SPF, any server can claim to send email as you. Pick your email providers below to create one.'}
				</p>
			)}

			<div className="space-y-3">
				<p className="text-sm font-medium text-ink-1" id="spf-providers-label">
					Sending providers
				</p>
				<ProviderPicker selected={selected} onAdd={(inc) => setSelected((s) => (s.includes(inc) ? s : [...s, inc]))} />
				{selected.length > 0 ? (
					<ul aria-labelledby="spf-providers-label" className="flex flex-wrap gap-2">
						{selected.map((inc) => {
							const name = providerName(inc);
							return (
								<li key={inc} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 py-0.5 pl-3 pr-1 text-sm">
									<span className="text-ink-1">{name}</span>
									{name !== inc ? <code className="font-mono text-xs text-ink-2">{inc}</code> : null}
									{detectedKnown.has(inc) ? <Badge variant="outline">current</Badge> : null}
									<IconButton label={`Remove ${name}`} size="sm" onClick={() => setSelected((s) => s.filter((x) => x !== inc))}>
										<X aria-hidden />
									</IconButton>
								</li>
							);
						})}
					</ul>
				) : (
					<FieldHint>No providers selected yet.</FieldHint>
				)}
			</div>

			<fieldset className="space-y-2">
				<legend className="text-sm font-medium text-ink-1">Mail from anyone else</legend>
				<div className="grid gap-2 sm:grid-cols-2">
					<RadioCard name="spf-qualifier" value="~all" checked={qualifier === '~all'} onChange={() => setQualifier('~all')} title="Softfail (~all)">
						Accepted but flagged. A safe start while you are still finding senders.
					</RadioCard>
					<RadioCard name="spf-qualifier" value="-all" checked={qualifier === '-all'} onChange={() => setQualifier('-all')} title="Hardfail (-all)">
						Rejected. Use once every legitimate sender is listed.
					</RadioCard>
				</div>
			</fieldset>

			{preview ? (
				<div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
					<span className="text-ink-2">DNS lookups in the proposed record:</span>
					{counting ? <span className="text-ink-2">Counting lookups…</span> : <LookupBadge count={lookupCount} estimate={realCount === null} suffix="lookups" />}
				</div>
			) : null}
			{preview && lookupCount > 10 && !counting ? (
				<Alert variant="warning" title="Over the 10-lookup limit">
					Receivers stop evaluating SPF after 10 DNS lookups and treat the record as a permanent error. Remove providers you do not need, or flatten the record later.
				</Alert>
			) : null}

			{showCompare ? (
				<RecordPair>
					<TxtRecord
						title="Current DNS record"
						value={spf.record ?? ''}
						badge={spf.lookup_count !== null ? <LookupBadge count={spf.lookup_count} /> : undefined}
					/>
					<TxtRecord title="Proposed record" value={preview} />
				</RecordPair>
			) : preview ? (
				<TxtRecord title={spf.record ? 'Current record' : 'Preview'} value={preview} />
			) : null}

			{removeAll ? <Alert variant="warning" title="Nothing selected">Select at least one provider to build a record. We never remove your SPF record from here.</Alert> : null}

			{!hasChanges && severity === 'good' && !applied ? (
				<p className="text-sm text-ink-2">Your SPF record is healthy. Inbox Angel checks it daily and warns you if it drifts toward the lookup limit.</p>
			) : null}

			{hasChanges && preview ? (
				<div className="space-y-2">
					<div className="flex flex-col gap-2 sm:flex-row">
						{cf_available ? (
							<WriteButton loading={apply.isPending && !overwrite} onClick={() => apply.mutate({ record: preview, confirm: false })}>
								Apply via Cloudflare
							</WriteButton>
						) : null}
						<CopyButton text={preview} />
					</div>
					{!cf_available ? <FieldHint>Cloudflare is not connected, so copy the record and publish it at your DNS provider.</FieldHint> : null}
					{apply.isError && !overwrite ? (
						<Alert variant="danger" title="Could not apply the record">
							{errorMessage(apply.error)}
						</Alert>
					) : null}
				</div>
			) : null}

			<StepFooter
				start={
					severity !== 'good' && !applied ? (
						<Button variant="ghost" onClick={onSkip}>
							Skip for now
						</Button>
					) : undefined
				}
				end={<Button onClick={onNext}>Continue</Button>}
			/>

			<SpfOverwriteDialog
				overwrite={overwrite}
				busy={apply.isPending}
				error={overwrite && apply.isError ? errorMessage(apply.error) : null}
				onCancel={() => {
					setOverwrite(null);
					apply.reset();
				}}
				onConfirm={() => overwrite && apply.mutate({ record: overwrite.record, confirm: true })}
			/>
		</StepCard>
	);
}
