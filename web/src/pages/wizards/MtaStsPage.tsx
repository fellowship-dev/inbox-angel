import { Alert, Badge, Button } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice, WriteButton } from '../../components/states';
import { RadioCard } from '../../components/wizard/RadioCard';
import { StepCard } from '../../components/wizard/StepCard';
import { StepFooter, StepNav } from '../../components/wizard/StepNav';
import { useRouteDomainId } from '../../components/wizard/useRouteDomainId';
import { WizardHeader } from '../../components/wizard/WizardHeader';
import { WizardProgress } from '../../components/wizard/WizardProgress';
import { api, errorMessage } from '../../lib/api';
import type { MtaStsStatus } from '../../lib/types';

type Mode = 'testing' | 'enforce';
const STEPS = ['MX discovery', 'Choose mode', 'Provision', 'Done'] as const;

const RECORDS = [
	{ name: '_mta-sts', type: 'TXT', purpose: 'MTA-STS policy version identifier' },
	{ name: '_smtp._tls', type: 'TXT', purpose: 'TLS-RPT address that receives failure reports' },
	{ name: 'mta-sts', type: 'CNAME', purpose: 'Points to the hosted policy file' },
] as const;

const splitHosts = (s: string | undefined) => (s ? s.split(',').map((h) => h.trim()).filter(Boolean) : []);

function HostList({ hosts }: { hosts: string[] }) {
	return (
		<ul className="list-disc space-y-0.5 pl-5 font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">
			{hosts.map((h) => (
				<li key={h}>{h}</li>
			))}
		</ul>
	);
}

export function MtaStsPage() {
	const domainId = useRouteDomainId();
	const qc = useQueryClient();
	const path = `/api/domains/${domainId}/mta-sts`;
	const queryKey = ['mta-sts', domainId] as const;
	const q = useQuery({ queryKey, queryFn: () => api<MtaStsStatus>(path), staleTime: 0, refetchOnMount: 'always' });

	const [step, setStep] = useState(0);
	const [pickedMode, setPickedMode] = useState<Mode | null>(null);
	const [mxHosts, setMxHosts] = useState<string[] | null>(null);
	// True once the enabling POST has succeeded. If the follow-up switch to enforce then fails, the domain really is
	// enabled (in testing mode) and the retry must only repeat the PATCH.
	const [provisioned, setProvisioned] = useState(false);

	const mode: Mode = pickedMode ?? q.data?.config?.mode ?? 'testing';

	async function finish() {
		await qc.invalidateQueries({ queryKey });
		setStep(3);
	}

	const enforce = useMutation({
		mutationFn: () => api<{ ok: boolean; mode: string; policy_id: string }>(path, { method: 'PATCH', body: { mode: 'enforce' } }),
		onSuccess: finish,
	});
	const enable = useMutation({
		mutationFn: () => api<{ ok: boolean; mode: string; mx_hosts: string[] }>(path, { method: 'POST' }),
		onSuccess: (r) => {
			setMxHosts(r.mx_hosts ?? []);
			setProvisioned(true);
			if (mode === 'enforce') enforce.mutate();
			else void finish();
		},
	});

	const back = `/domains/${domainId}`;
	let body;
	if (q.isPending) body = <PageSkeleton label="Loading MTA-STS" />;
	else if (q.isError) body = <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load MTA-STS" />;
	else {
		const status = q.data;
		const active = !!status.config?.enabled;
		const hosts = mxHosts ?? splitHosts(status.config?.mx_hosts);
		const partial = provisioned && enforce.isError;
		const busy = enable.isPending || enforce.isPending;

		body = (
			<>
				<WizardProgress label="MTA-STS progress" current={step} steps={STEPS.map((label, i) => ({ label, state: i < step ? 'complete' : 'pending' }))} />

				{step === 0 ? (
					<StepCard title="MX discovery">
						<p className="text-sm text-ink-2">
							MTA-STS tells sending mail servers to always use TLS when delivering to your domain, which prevents downgrade attacks. Your MX hosts are discovered automatically when you
							enable it.
						</p>
						{active && hosts.length > 0 ? (
							<Alert variant="success" title={`MTA-STS is already active (${status.config?.mode} mode)`}>
								<p className="mb-1 font-medium text-ink-1">Discovered MX hosts</p>
								<HostList hosts={hosts} />
							</Alert>
						) : null}
						{!active ? <Alert variant="info">MX hosts are discovered from your DNS when MTA-STS is enabled. There is no preview before that.</Alert> : null}
						<StepNav onNext={() => setStep(1)} showSkip={false} />
					</StepCard>
				) : null}

				{step === 1 ? (
					<StepCard title="Choose enforcement mode">
						<fieldset className="space-y-3">
							<legend className="sr-only">Enforcement mode</legend>
							<RadioCard
								name="mta-sts-mode"
								value="testing"
								checked={mode === 'testing'}
								onChange={() => setPickedMode('testing')}
								disabled={active}
								title="Testing"
								badge={<Badge variant="brand">Recommended</Badge>}
							>
								Report-only. Sending servers report TLS failures but still deliver mail. Start here to check that everything works.
							</RadioCard>
							<RadioCard name="mta-sts-mode" value="enforce" checked={mode === 'enforce'} onChange={() => setPickedMode('enforce')} disabled={active} title="Enforce">
								Sending servers refuse to deliver if TLS cannot be established. Only use after you have seen zero TLS failures in testing mode.
							</RadioCard>
						</fieldset>
						{active ? <p className="text-sm text-ink-2">MTA-STS is already enabled in {status.config?.mode} mode, so the mode cannot be chosen here.</p> : null}
						<StepNav onNext={() => setStep(2)} onBack={() => setStep(0)} showSkip={false} />
					</StepCard>
				) : null}

				{step === 2 ? (
					<StepCard title="Provision MTA-STS">
						<p className="text-sm text-ink-2">Enabling MTA-STS creates 3 DNS records for your domain.</p>
						<ul className="space-y-2">
							{RECORDS.map((r) => (
								<li key={r.name} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
									<code className="font-mono font-semibold text-ink-1">
										{r.name} {r.type}
									</code>
									<span className="text-ink-2"> - {r.purpose}</span>
								</li>
							))}
						</ul>
						<Alert variant={mode === 'enforce' ? 'warning' : 'info'} title={`Mode: ${mode}`}>
							{mode === 'testing' ? 'Failures are reported but mail is still delivered.' : 'Mail is rejected when TLS fails.'}
						</Alert>

						{partial ? (
							<Alert variant="warning" title="Enabled in testing mode; switching to enforce failed">
								<p>The three DNS records exist and MTA-STS is running in testing mode. Switching to enforce failed: {errorMessage(enforce.error)}</p>
								<div className="mt-3 flex flex-col gap-2 sm:flex-row">
									<WriteButton variant="secondary" size="sm" loading={enforce.isPending} onClick={() => enforce.mutate()}>
										Retry switching to enforce
									</WriteButton>
									<Button variant="ghost" size="sm" onClick={() => void finish()}>
										Continue in testing mode
									</Button>
								</div>
							</Alert>
						) : enable.isError ? (
							<Alert variant="danger" title="Could not enable MTA-STS">
								{errorMessage(enable.error)}
							</Alert>
						) : null}
						{!status.available && !active ? (
							<Alert variant="warning" title="Not available here">
								MTA-STS needs Cloudflare DNS and Workers to publish the policy, and no Cloudflare connection is configured.
							</Alert>
						) : null}

						<StepFooter
							start={
								<Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
									Back
								</Button>
							}
							end={
								active ? (
									<Button onClick={() => setStep(3)}>Continue</Button>
								) : provisioned ? null : (
									<WriteButton loading={busy} disabled={!status.available} onClick={() => enable.mutate()}>
										{busy ? 'Provisioning…' : 'Enable MTA-STS'}
									</WriteButton>
								)
							}
						/>
					</StepCard>
				) : null}

				{step === 3 ? (
					<StepCard title="MTA-STS enabled">
						<Alert variant="success" title="MTA-STS is provisioned for your domain">
							<p>
								Mode: <strong className="text-ink-1">{status.config?.mode ?? mode}</strong>
							</p>
							<p>3 DNS records created. TLS failure reports are collected automatically.</p>
						</Alert>
						{hosts.length > 0 ? (
							<div className="space-y-1">
								<p className="text-sm font-medium text-ink-1">Discovered MX hosts</p>
								<HostList hosts={hosts} />
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
			<WizardHeader backTo={back} title="MTA-STS setup" subtitle="Require TLS for mail delivered to your domain." />
			<ReadOnlyNotice />
			{body}
		</div>
	);
}
