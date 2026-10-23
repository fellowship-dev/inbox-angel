import { FieldError, FieldHint, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@inbox-angel/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ClaimCard } from '../../../components/domain/ClaimCard';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter } from '../../../components/wizard/StepNav';
import { WriteButton } from '../../../components/states';
import { api, errorMessage } from '../../../lib/api';
import type { DomainClaim } from '../../../lib/types';

interface Zone {
	id: string;
	name: string;
	status: string;
}

interface BaseDomainResult {
	ok: boolean;
	domain: string | null;
	domain_id?: number;
	reports_domain?: string;
	/** 202: the domain's ownership still has to be proven with a DNS TXT record. */
	pending?: boolean;
	claim?: DomainClaim;
}

export const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** Step 1, only when the instance has no domain yet: choose the home-base domain that receives all reports. */
export function DomainStep({ onDomainSet }: { onDomainSet: (domainId: number) => void }) {
	const fieldId = useId();
	const hintId = useId();
	const [domain, setDomain] = useState('');
	const [manual, setManual] = useState(false);
	const [validation, setValidation] = useState('');
	const [claim, setClaim] = useState<DomainClaim | null>(null);

	// A failed zone lookup (no Cloudflare token, API down) just means typing the domain by hand.
	const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ zones: Zone[] }>('/api/zones').then((r) => r.zones), retry: false });
	const zoneList = zones.data ?? [];
	const showSelect = !manual && zoneList.length > 0;

	const save = useMutation({
		mutationFn: (d: string) => api<BaseDomainResult>('/api/settings/base-domain', { method: 'POST', body: { domain: d } }),
		onSuccess: (r) => {
			if (r.pending && r.claim) setClaim(r.claim);
			else if (r.domain_id !== undefined) onDomainSet(r.domain_id);
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		const d = domain.toLowerCase().trim();
		if (!DOMAIN_PATTERN.test(d)) {
			setValidation('Enter a valid domain like yourdomain.com');
			return;
		}
		setValidation('');
		save.mutate(d);
	}

	if (claim) {
		return (
			<StepCard title="Verify you own this domain" focusHeading={false}>
				<ClaimCard claim={claim} onVerified={(d) => onDomainSet(d.id)} onRemoved={() => setClaim(null)} />
			</StepCard>
		);
	}

	const error = validation || (save.isError ? errorMessage(save.error) : '');
	return (
		<StepCard title="What's your main domain?" focusHeading={false}>
			<form onSubmit={submit} className="space-y-4" noValidate>
				<p className="text-sm text-ink-2">
					Pick the domain you want as your Inbox Angel home base. We create a <code className="font-mono text-ink-1">reports</code> subdomain here to receive email
					authentication reports, and every domain you add later sends its reports there too.
				</p>
				<div className="space-y-1.5">
					<Label htmlFor={fieldId}>Main domain</Label>
					{showSelect ? (
						<Select value={domain} onValueChange={setDomain}>
							<SelectTrigger id={fieldId} aria-describedby={hintId} aria-invalid={error ? true : undefined}>
								<SelectValue placeholder="Select a domain from your Cloudflare account" />
							</SelectTrigger>
							<SelectContent>
								{zoneList.map((z) => (
									<SelectItem key={z.id} value={z.name}>
										{z.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<Input
							id={fieldId}
							placeholder="yourdomain.com"
							autoFocus
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							value={domain}
							onChange={(e) => setDomain(e.target.value)}
							aria-describedby={hintId}
							aria-invalid={error ? true : undefined}
						/>
					)}
					<FieldHint id={hintId}>
						{showSelect ? (
							<>
								Not listed?{' '}
								<button
									type="button"
									className="text-brand-ink underline underline-offset-4"
									onClick={() => {
										setManual(true);
										setDomain('');
									}}
								>
									Enter it manually
								</button>
							</>
						) : zones.isPending ? (
							'Looking up the domains in your Cloudflare account…'
						) : (
							'The domain you own, without www or a path.'
						)}
					</FieldHint>
					{error ? <FieldError>{error}</FieldError> : null}
				</div>
				<StepFooter
					end={
						<WriteButton type="submit" loading={save.isPending} disabled={!domain.trim()}>
							{save.isPending ? 'Setting up…' : 'Continue'}
						</WriteButton>
					}
				/>
			</form>
		</StepCard>
	);
}
