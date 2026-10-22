import { Alert, CheckResult, CheckResultList, RecordBlock, toast } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { WriteButton } from '../../../components/states';
import { CopyButton } from '../../../components/wizard/CopyButton';
import { TxtRecord } from '../../../components/wizard/RecordPair';
import { SeverityBadge } from '../../../components/wizard/SeverityBadge';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepNav } from '../../../components/wizard/StepNav';
import { api, errorMessage } from '../../../lib/api';
import { buildRecommendedRecord, parseDmarcPolicy } from '../../../lib/dmarc-record';
import type { OnboardingStatus } from '../../../lib/types';
import { setupKeys } from './hooks';
import type { StepProps } from './SpfStep';
import { dmarcSeverity, dnsErrorDetail, dnsErrorsFor } from './steps';

interface ApplyDmarcResponse {
	ok: boolean;
	record: string;
	created: boolean;
}

export function DmarcStep({ status, onNext, onSkip, onRetry }: StepProps) {
	const qc = useQueryClient();
	const { dmarc, cf_available } = status;
	const dmarcFailed = dnsErrorsFor(status, 'dmarc');
	const authFailed = dnsErrorsFor(status, 'authRecord');
	const [applied, setApplied] = useState(false);
	const [authProvisioned, setAuthProvisioned] = useState(false);

	const severity = dmarcSeverity(dmarc, dmarcFailed.length > 0);
	// Adding our rua= must never relax an existing policy, so keep p= as it is and only default to none for a new record.
	const recommended = buildRecommendedRecord(dmarc.current_record, parseDmarcPolicy(dmarc.current_record) ?? 'none', dmarc.rua_address);

	const patch = (fn: (s: OnboardingStatus) => OnboardingStatus) => qc.setQueryData<OnboardingStatus>(setupKeys.status(status.domain_id), (s) => (s ? fn(s) : s));

	const apply = useMutation({
		mutationFn: () => api<ApplyDmarcResponse>(`/api/domains/${status.domain_id}/apply-dmarc`, { body: { record: recommended } }),
		onSuccess: () => {
			setApplied(true);
			toast({ variant: 'success', title: 'DMARC record applied', description: 'Reports start arriving within 24 hours.' });
			patch((s) => ({ ...s, dmarc: { ...s.dmarc, found: true, has_our_rua: true, current_record: recommended } }));
		},
	});

	// Re-applying the current record makes the server create the cross-domain authorization record as a side effect.
	const provision = useMutation({
		mutationFn: () => api<ApplyDmarcResponse>(`/api/domains/${status.domain_id}/apply-dmarc`, { body: { record: dmarc.current_record } }),
		onSuccess: () => {
			setAuthProvisioned(true);
			toast({ variant: 'success', title: 'Authorization record created' });
			patch((s) => ({ ...s, dmarc: { ...s.dmarc, auth_record: s.dmarc.auth_record ? { ...s.dmarc.auth_record, found: true } : s.dmarc.auth_record } }));
		},
	});

	const auth = dmarc.auth_record;
	const authFound = auth?.found || authProvisioned;

	return (
		<StepCard title="DMARC policy" badge={<SeverityBadge severity={applied ? 'info' : severity} />}>
			{dmarcFailed.length > 0 ? (
				<>
					<CheckResultList>
						<CheckResult
							status="error"
							title={`DMARC for _dmarc.${status.domain}`}
							summary={`The DNS lookup failed (${dnsErrorDetail(dmarcFailed[0] ?? '')}).`}
							onRetry={onRetry}
						/>
					</CheckResultList>
					<p className="text-sm text-ink-2">We cannot tell whether you already have a DMARC record, so we will not suggest creating one. Try again, or continue and come back.</p>
				</>
			) : (
				<>
					{dmarc.current_record ? (
						<TxtRecord title="Current record" name="_dmarc" value={dmarc.current_record} />
					) : (
						<p className="text-sm text-ink-2">
							No DMARC record found for <strong className="text-ink-1">_dmarc.{status.domain}</strong>.
						</p>
					)}
					{severity === 'error' && !applied ? (
						<p className="text-sm text-ink-2">
							Without a DMARC record receiving servers send no reports, so Inbox Angel has nothing to analyse. Create one with <code className="font-mono text-ink-1">p=none</code>{' '}
							(monitor only) so reports start flowing.
						</p>
					) : null}
					{severity === 'warning' && !applied ? (
						<p className="text-sm text-ink-2">
							Your DMARC record exists but does not send reports to Inbox Angel. Add <code className="font-mono text-ink-1">rua=mailto:{dmarc.rua_address}</code> to receive
							aggregate reports.
						</p>
					) : null}
					{severity === 'info' || applied ? (
						<Alert variant={applied ? 'success' : 'info'} title={applied ? 'DMARC record applied' : 'Reports are configured'}>
							Reports will start arriving within 24 hours. Once there is data, the dashboard guides you from <code className="font-mono">p=none</code> to{' '}
							<code className="font-mono">p=reject</code> safely.
						</Alert>
					) : null}
					{(severity === 'error' || severity === 'warning') && !applied ? (
						<div className="space-y-3">
							<TxtRecord title="Recommended record" name="_dmarc" value={recommended} />
							<div className="flex flex-col gap-2 sm:flex-row">
								{cf_available ? (
									<WriteButton loading={apply.isPending} onClick={() => apply.mutate()}>
										Apply via Cloudflare
									</WriteButton>
								) : null}
								<CopyButton text={recommended} />
							</div>
							{apply.isError ? (
								<Alert variant="danger" title="Could not apply the record">
									{errorMessage(apply.error)}
								</Alert>
							) : null}
						</div>
					) : null}
				</>
			)}

			{auth ? (
				<section aria-label="Report authorization record" className="space-y-2">
					<h3 className="text-sm font-semibold text-ink-1">Report authorization record</h3>
					<CheckResultList>
						{authFailed.length > 0 ? (
							<CheckResult
								status="error"
								title="Authorization record"
								summary={`The DNS lookup failed (${dnsErrorDetail(authFailed[0] ?? '')}).`}
								onRetry={onRetry}
							/>
						) : authFound ? (
							<CheckResult status="pass" statusLabel="Found" title="Authorization record" summary={`${auth.record_name ?? 'The record'} authorizes this domain to receive DMARC reports.`} />
						) : (
							<CheckResult
								status="missing"
								statusLabel="Missing"
								title="Authorization record"
								summary="RFC 7489 requires a TXT record to authorize cross-domain report delivery. Without it, some providers silently drop DMARC reports."
							>
								{auth.record_name ? (
									<div className="mt-2 space-y-3">
										<RecordBlock title="Required record" record={{ type: 'TXT', name: auth.record_name, value: 'v=DMARC1;' }} />
										{cf_available && dmarc.current_record ? (
											<WriteButton loading={provision.isPending} onClick={() => provision.mutate()}>
												Create via Cloudflare
											</WriteButton>
										) : null}
										{provision.isError ? (
											<Alert variant="danger" title="Could not create the record">
												{errorMessage(provision.error)}
											</Alert>
										) : null}
									</div>
								) : null}
							</CheckResult>
						)}
					</CheckResultList>
				</section>
			) : null}

			<StepNav onNext={onNext} onSkip={onSkip} showSkip={severity !== 'info' && !applied} />
		</StepCard>
	);
}
