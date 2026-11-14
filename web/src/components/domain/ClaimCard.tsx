import { Alert, Badge, Button } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import type { Domain, DomainClaim } from '../../lib/types';
import { HELP_PRIORITY, TalkToMax } from '../TalkToMax';
import { PlanLimitNotice, planLimitOf, type PlanLimit } from '../PlanLimitNotice';
import { ClaimPreview } from './ClaimPreview';
import { CopyField } from './CopyField';

export const LOST_EXPLANATION = 'Another workspace verified this domain first, so it cannot be added to this one.';

/** The record is not visible in public DNS yet: nothing is wrong, DNS takes a while. */
export const NOT_VISIBLE_YET = "We don't see the record yet. DNS changes can take a few minutes to show up. Verify again in a minute.";

/** The server's 422 says the record is simply not visible yet (as opposed to a lookup that failed or another refusal). */
const notVisibleYet = (e: unknown): boolean => e instanceof ApiError && e.status === 422 && (e.body as { code?: string } | undefined)?.code === 'not_found_yet';

/** What the server said when the TXT record was not (yet) found: its reason, else the claim's last error. */
function verifyFailure(e: unknown): string {
	if (notVisibleYet(e)) return NOT_VISIBLE_YET;
	if (e instanceof ApiError) {
		const claim = (e.body as { claim?: { last_error?: string | null } } | undefined)?.claim;
		return claim?.last_error && claim.last_error !== e.message ? `${e.message} ${claim.last_error}` : e.message;
	}
	return errorMessage(e);
}

/**
 * A domain that is not ours to monitor yet: add this TXT record to prove ownership, then Verify.
 * `pending` has no reports, stats or DNS: only the claim exists. `lost` can only be removed.
 */
export function ClaimCard({ claim, onVerified, onRemoved, canWrite = true, preview }: { claim: DomainClaim; onVerified?: (domain: Domain, info: { resumed: boolean }) => void; onRemoved?: () => void; canWrite?: boolean; /** Show what public DNS says about the domain: `true` loads it now, `'lazy'` waits for a click. */ preview?: boolean | 'lazy' }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [error, setError] = useState('');
	/** Failed Verify presses on this card: after two, a person is offered. */
	const [failures, setFailures] = useState(0);
	/** The last press found nothing yet: the button offers to check again. Not a lockout: Verify can be pressed any time. */
	const [waiting, setWaiting] = useState(false);
	const [limit, setLimit] = useState<PlanLimit | null>(null);
	const refresh = () => qc.invalidateQueries({ queryKey: ['domains'] });

	const verify = useMutation({
		mutationFn: () => api<{ domain: Domain; resumed?: boolean }>(`/api/domains/claims/${claim.id}/verify`, { method: 'POST' }),
		onSuccess: async (res) => {
			await refresh();
			// `resumed`: the workspace already had the domain, so this press verified nothing new.
			if (onVerified) onVerified(res.domain, { resumed: res.resumed === true });
			else navigate(`/domains/${res.domain.id}`);
		},
		onError: (e) => {
			const atLimit = planLimitOf(e);
			if (atLimit) return setLimit(atLimit);
			setError(verifyFailure(e));
			setWaiting(notVisibleYet(e));
			setFailures((n) => n + 1);
			if (e instanceof ApiError && e.status === 409) void refresh();
		},
	});
	const remove = useMutation({
		mutationFn: () => api(`/api/domains/claims/${claim.id}`, { method: 'DELETE' }),
		onSuccess: async () => {
			await refresh();
			onRemoved?.();
		},
		onError: (e) => setError(errorMessage(e)),
	});
	const lost = claim.status === 'lost';

	return (
		<div className="space-y-4 rounded-lg border border-line p-4" data-testid={`claim-${claim.id}`}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-mono text-base font-semibold [overflow-wrap:anywhere]">{claim.domain}</h3>
				<Badge variant={lost ? 'danger' : 'warning'}>{lost ? 'Claimed elsewhere' : 'Waiting for verification'}</Badge>
			</div>
			{lost ? (
				<>
					<Alert variant="warning">{LOST_EXPLANATION}</Alert>
					<TalkToMax priority={HELP_PRIORITY.claimStuck} lead="Is it yours?" about="about getting access to it" />
				</>
			) : (
				<>
					{preview ? <ClaimPreview claimId={claim.id} domain={claim.domain} lazy={preview === 'lazy'} /> : null}
					<p className="text-sm text-ink-2">
						Prove you own <strong>{claim.domain}</strong> by adding this DNS record where you manage it, then press Verify. DNS changes can take a few minutes to propagate.
					</p>
					<div className="grid gap-3 sm:grid-cols-3">
						<CopyField label="Type" value="TXT" />
						<CopyField label="Name" value={claim.txt_name} />
						<CopyField label="Value" value={claim.txt_value} />
					</div>
					{claim.last_error && !error ? <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">Last check: {/ not found yet /.test(claim.last_error) ? 'the record was not visible yet.' : claim.last_error}</p> : null}
				</>
			)}
			{limit ? <PlanLimitNotice limit={limit} /> : null}
			{error ? (
				<Alert variant={waiting ? 'info' : 'warning'} role="alert">
					<span className="[overflow-wrap:anywhere]">{error}</span>
				</Alert>
			) : null}
			{!lost && failures >= 2 ? <TalkToMax priority={HELP_PRIORITY.claimStuck} lead="Added the record and it still does not verify?" about={`about ${claim.domain}`} /> : null}
			<div className="flex flex-wrap gap-2">
				{!lost ? (
					<Button loading={verify.isPending} disabled={!canWrite} onClick={() => { setError(''); setLimit(null); verify.mutate(); }}>
						{waiting ? 'Verify again' : 'Verify'}
					</Button>
				) : null}
				<Button variant="secondary" loading={remove.isPending} disabled={!canWrite} aria-label={`Remove ${claim.domain}`} onClick={() => { setError(''); remove.mutate(); }}>
					Remove
				</Button>
			</div>
		</div>
	);
}
