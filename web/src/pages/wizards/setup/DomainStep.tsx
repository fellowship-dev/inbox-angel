import { FieldError, FieldHint, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@ready-set-mail/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ClaimCard } from '../../../components/domain/ClaimCard';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepFooter } from '../../../components/wizard/StepNav';
import { WriteButton } from '../../../components/states';
import { DomainRefusalHelp } from '../../../components/TalkToMax';
import { PlanLimitNotice, planLimitOf } from '../../../components/PlanLimitNotice';
import { api, errorMessage } from '../../../lib/api';
import { useDomainClaims } from '../../../lib/queries';
import { normalizeDomainInput } from '../../../lib/domain-input';
import { useHosted } from '../../../lib/session';
import { clearSignupDomainIf, readSignupDomain } from '../../../lib/signup-intent';
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
	// The domain asked for on the website, if any: a prefill the person confirms with Continue.
	const [domain, setDomain] = useState(() => readSignupDomain() ?? '');
	const [manual, setManual] = useState(false);
	const [validation, setValidation] = useState('');
	const [claim, setClaim] = useState<DomainClaim | null>(null);
	/** The person chose "Add a different domain" over the claims already waiting. */
	const [adding, setAdding] = useState(false);
	const hosted = useHosted();
	// Hosted: claims made on an earlier visit, still waiting for their DNS proof. Coming back, the person lands on them, not on an empty field.
	const claims = useDomainClaims();

	// A failed zone lookup (no Cloudflare token, API down) just means typing the domain by hand.
	const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<{ zones: Zone[] }>('/api/zones').then((r) => r.zones), retry: false });
	const zoneList = zones.data ?? [];
	// A prefilled domain that is not one of the listed zones is typed, not picked.
	const showSelect = !manual && zoneList.length > 0 && (domain === '' || zoneList.some((z) => z.name === domain));

	const save = useMutation({
		mutationFn: (d: string) => api<BaseDomainResult>('/api/settings/base-domain', { method: 'POST', body: { domain: d } }),
		onSuccess: (r, d) => {
			clearSignupDomainIf(d);
			if (r.pending && r.claim) setClaim(r.claim);
			else if (r.domain_id !== undefined) onDomainSet(r.domain_id);
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		const d = normalizeDomainInput(domain);
		if (!d || !DOMAIN_PATTERN.test(d)) {
			setValidation('Enter a valid domain like yourdomain.com');
			return;
		}
		setValidation('');
		save.mutate(d);
	}

	if (claim) {
		return (
			<StepCard title="Verify you own this domain" focusHeading={false}>
				<ClaimCard claim={claim} preview onVerified={(d) => onDomainSet(d.id)} onRemoved={() => setClaim(null)} />
			</StepCard>
		);
	}

	if (hosted && !adding && claims.isPending) {
		return (
			<StepCard title="Which domain do you send email from?" focusHeading={false}>
				<Skeleton className="h-24 w-full" role="status" aria-label="Checking for domains you added" />
			</StepCard>
		);
	}
	const requested = readSignupDomain();
	const waiting = hosted && !adding ? (claims.data ?? []).filter((c) => c.status === 'pending').sort((a, b) => Number(b.domain === requested) - Number(a.domain === requested)) : [];
	if (waiting.length > 0) {
		return (
			<StepCard title={waiting.length === 1 ? 'Verify you own this domain' : 'Verify you own these domains'} focusHeading={false}>
				<div className="space-y-4">
					<p className="text-sm text-ink-2">
						{waiting.length === 1
							? 'You added this domain earlier. It is waiting for the DNS record that proves it is yours.'
							: 'You added these domains earlier. Each is waiting for the DNS record that proves it is yours.'}
					</p>
					{waiting.map((c, i) => (
						<ClaimCard key={c.id} claim={c} preview={i === 0 ? true : 'lazy'} onVerified={(d) => onDomainSet(d.id)} />
					))}
					<button type="button" className="text-sm text-brand-ink underline underline-offset-4" onClick={() => setAdding(true)}>
						Add a different domain
					</button>
				</div>
			</StepCard>
		);
	}

	const atLimit = save.isError ? planLimitOf(save.error) : null;
	const error = validation || (save.isError && !atLimit ? errorMessage(save.error) : '');
	return (
		<StepCard title={hosted ? 'Which domain do you send email from?' : "What's your main domain?"} focusHeading={false}>
			<form onSubmit={submit} className="space-y-4" noValidate>
				{hosted ? (
					<p className="text-sm text-ink-2">
						Start with one domain; you can add more later. You prove it is yours with one DNS record, then we check its SPF, DKIM and DMARC from live DNS and show
						you what to fix.
					</p>
				) : (
					<p className="text-sm text-ink-2">
						Pick the domain you want as your Ready Set Mail home base. We create a <code className="font-mono text-ink-1">reports</code> subdomain here to receive email
						authentication reports, and every domain you add later sends its reports there too.
					</p>
				)}
				<div className="space-y-1.5">
					<Label htmlFor={fieldId}>{hosted ? 'Domain' : 'Main domain'}</Label>
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
					{save.isError && !atLimit ? <DomainRefusalHelp error={save.error} /> : null}
					{atLimit ? <PlanLimitNotice limit={atLimit} /> : null}
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
