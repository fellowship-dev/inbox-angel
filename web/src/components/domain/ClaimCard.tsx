import { Alert, Badge, Button } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import type { Domain, DomainClaim } from '../../lib/types';
import { CopyField } from './CopyField';

export const LOST_EXPLANATION = 'Another workspace verified this domain first. If it is yours, contact support.';

/** What the server said when the TXT record was not (yet) found: its reason, else the claim's last error. */
function verifyFailure(e: unknown): string {
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
export function ClaimCard({ claim, onVerified, onRemoved, canWrite = true }: { claim: DomainClaim; onVerified?: (domain: Domain) => void; onRemoved?: () => void; canWrite?: boolean }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [error, setError] = useState('');
	const refresh = () => qc.invalidateQueries({ queryKey: ['domains'] });

	const verify = useMutation({
		mutationFn: () => api<{ domain: Domain }>(`/api/domains/claims/${claim.id}/verify`, { method: 'POST' }),
		onSuccess: async (res) => {
			await refresh();
			if (onVerified) onVerified(res.domain);
			else navigate(`/domains/${res.domain.id}`);
		},
		onError: (e) => {
			setError(verifyFailure(e));
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
				<Alert variant="warning">{LOST_EXPLANATION}</Alert>
			) : (
				<>
					<p className="text-sm text-ink-2">
						Prove you own <strong>{claim.domain}</strong> by adding this DNS record where you manage it, then press Verify. DNS changes can take a few minutes to propagate.
					</p>
					<div className="grid gap-3 sm:grid-cols-3">
						<CopyField label="Type" value="TXT" />
						<CopyField label="Name" value={claim.txt_name} />
						<CopyField label="Value" value={claim.txt_value} />
					</div>
					{claim.last_error && !error ? <p className="text-sm text-ink-2">Last check: {claim.last_error}</p> : null}
				</>
			)}
			{error ? (
				<Alert variant="warning" role="alert">
					{error}
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				{!lost ? (
					<Button loading={verify.isPending} disabled={!canWrite} onClick={() => { setError(''); verify.mutate(); }}>
						Verify
					</Button>
				) : null}
				<Button variant="secondary" loading={remove.isPending} disabled={!canWrite} aria-label={`Remove ${claim.domain}`} onClick={() => { setError(''); remove.mutate(); }}>
					Remove
				</Button>
			</div>
		</div>
	);
}
