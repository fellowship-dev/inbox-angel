import { Alert, Badge, RecordBlock, cn, toast } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { domainKeys, useRolloutNext, type RolloutNext } from '../../lib/domain-queries';
import type { Domain } from '../../lib/types';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';
import { ConfirmDialog } from './ConfirmDialog';

const label = (policy: string, testing: boolean) => `${policy === 'quarantine' ? 'Quarantine' : policy === 'reject' ? 'Reject' : policy}${testing ? ' (testing, t=y)' : ''}`;

function Progress({ r }: { r: RolloutNext }) {
	const step = r.current_step_index + 1;
	return (
		<div className="space-y-1.5">
			<div
				role="progressbar"
				aria-label="Rollout progress"
				aria-valuemin={1}
				aria-valuemax={r.total_steps}
				aria-valuenow={step}
				aria-valuetext={`Step ${step} of ${r.total_steps}`}
				className="flex gap-1"
			>
				{Array.from({ length: r.total_steps }, (_, i) => (
					<div key={i} className={cn('h-2 flex-1 rounded-full', i < step ? 'bg-brand-ink' : 'bg-surface-3')} />
				))}
			</div>
			<div className="flex flex-wrap justify-between gap-x-4 text-sm text-ink-2">
				<span>
					Step {step} of {r.total_steps}
				</span>
				<span>{r.next_step ? `Next: ${label(r.next_step.policy, r.next_step.testing)}` : 'Complete'}</span>
			</div>
		</div>
	);
}

/** RFC 9989 staged rollout. Advancing records the step: the person still changes DNS by hand. */
export function Rollout({ domain }: { domain: Domain }) {
	const qc = useQueryClient();
	const q = useRolloutNext(domain.id);
	const [open, setOpen] = useState(false);

	const advance = useMutation({
		mutationFn: (step: { policy: string; testing: boolean }) => api(`/api/domains/${domain.id}/rollout-advance`, { method: 'POST', body: step }),
		onSuccess: async () => {
			toast({ title: 'Step recorded', description: 'Rollout progress was updated.', variant: 'success' });
			setOpen(false);
			await qc.invalidateQueries({ queryKey: domainKeys.rollout(domain.id) });
		},
	});

	if (q.isPending) return <Section title="Rollout"><ListSkeleton rows={1} label="Loading rollout" /></Section>;
	if (q.isError) return <Section title="Rollout"><LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the rollout" /></Section>;
	const r = q.data;
	// Without an enforcing record there is no rollout to show (guidance above covers p=none).
	if (r.current_policy !== 'quarantine' && r.current_policy !== 'reject') return null;

	return (
		<Section
			title="Rollout progress"
			description={
				<>
					Current policy: <strong>{label(r.current_policy, r.current_testing)}</strong>
				</>
			}
			actions={
				r.next_step ? (
					<WriteButton size="sm" disabled={r.blocked} title={r.block_reason ?? undefined} onClick={() => setOpen(true)}>
						Advance policy
					</WriteButton>
				) : (
					<Badge variant="success">
						<CheckCircle2 aria-hidden />
						Fully graduated
					</Badge>
				)
			}
		>
			<div className="space-y-3 rounded-lg border border-line bg-surface-1 p-4">
				{r.behind_schedule ? (
					<Badge variant="warning">
						<AlertTriangle aria-hidden />
						Behind schedule
					</Badge>
				) : null}
				<Progress r={r} />
				{r.next_step && r.next_step_note ? <p className="text-sm text-ink-2">{r.next_step_note}</p> : null}
				{r.blocked && r.block_reason ? (
					<Alert variant="warning" title="Cannot advance yet">
						{r.block_reason}
					</Alert>
				) : null}
				{r.has_unknown_senders && !r.blocked ? (
					<p className="text-sm text-ink-2">Note: unknown senders were still seen in the last 7 days. Verify all legitimate senders are configured before advancing.</p>
				) : null}
			</div>
			{r.next_step ? (
				<ConfirmDialog
					open={open}
					onOpenChange={(o) => {
						setOpen(o);
						if (!o) advance.reset();
					}}
					title={`Advance to ${label(r.next_step.policy, r.next_step.testing)}`}
					description={
						<>
							Update the <code>_dmarc.{domain.domain}</code> TXT record to the value below at your DNS provider, then mark it as applied. Inbox Angel does not change DNS here.
						</>
					}
					confirmLabel="Mark as applied"
					busyLabel="Saving…"
					busy={advance.isPending}
					error={advance.isError ? errorMessage(advance.error) : null}
					onConfirm={() => r.next_step && advance.mutate(r.next_step)}
				>
					{r.next_step_note ? (
						<Alert variant="warning" title="Heads up">
							{r.next_step_note}
						</Alert>
					) : null}
					{r.dns_preview ? <RecordBlock record={{ type: 'TXT', name: `_dmarc.${domain.domain}`, value: r.dns_preview }} /> : null}
				</ConfirmDialog>
			) : null}
		</Section>
	);
}
