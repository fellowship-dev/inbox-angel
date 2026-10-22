import { Alert, Button, CheckResult, CheckResultList } from '@inbox-angel/ui';
import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { WriteButton } from '../../../components/states';
import { SeverityBadge } from '../../../components/wizard/SeverityBadge';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepNav } from '../../../components/wizard/StepNav';
import { api, errorMessage } from '../../../lib/api';
import type { StepProps } from './SpfStep';
import { dnsErrorDetail, dnsErrorsFor, routingSeverity } from './steps';

interface RoutingResult {
	ok: boolean;
	reports_domain: string;
	status: string;
	detail: string;
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="font-mono text-ink-1 [overflow-wrap:anywhere]">{children}</code>;

export function RoutingStep({ status, onNext, onSkip, onRetry, retrying }: StepProps) {
	const { routing } = status;
	const mxFailed = dnsErrorsFor(status, 'mx');
	const nullFailed = dnsErrorsFor(status, 'nullSender');
	const severity = routingSeverity(routing, mxFailed.length + nullFailed.length > 0);
	const [info, setInfo] = useState<string | null>(null);

	const setup = useMutation({
		mutationFn: () => api<RoutingResult>('/api/setup/email-routing', { method: 'POST' }),
		onSuccess: (r) => {
			setInfo(
				r.status === 'already_configured'
					? 'Email routing is already configured. MX records may take a few minutes to propagate, so re-check shortly.'
					: r.status === 'newly_configured'
						? 'Email routing configured. MX records are created and the catch-all rule is set.'
						: null,
			);
			onRetry();
		},
	});
	const register = useMutation({
		mutationFn: () => api<{ ok: boolean; email: string; verification_sent: boolean }>('/api/settings/register-destination', { method: 'POST' }),
		onSuccess: () => setInfo('Verification email sent. Open the link from Cloudflare in your inbox, then press "Re-check".'),
	});
	const error = setup.isError ? errorMessage(setup.error) : register.isError ? errorMessage(register.error) : null;
	const rd = routing.reports_domain;
	const nullMissing = [!routing.null_sender_spf && 'SPF', !routing.null_sender_dmarc && 'DMARC'].filter(Boolean).join(' and ');

	return (
		<StepCard title="Reports routing" badge={<SeverityBadge severity={severity} />}>
			<CheckResultList>
				{mxFailed.length > 0 ? (
					<CheckResult
						status="error"
						title="MX records"
						summary={`The DNS lookup for ${rd ?? 'the reports domain'} failed (${dnsErrorDetail(mxFailed[0] ?? '')}).`}
						onRetry={onRetry}
					/>
				) : routing.mx_found ? (
					<CheckResult status="pass" statusLabel="Found" title="MX records">
						MX records found for <Code>{rd}</Code>, so reports can reach Inbox Angel.
					</CheckResult>
				) : (
					<CheckResult
						status="missing"
						title="MX records"
						summary={
							<>
								No MX records found for <Code>{rd ?? 'your reports domain'}</Code>. Email routing must be set up so DMARC reports can reach Inbox Angel.
							</>
						}
					>
						<p className="text-ink-2">This creates MX records for your reports subdomain and a catch-all routing rule that forwards incoming reports to the Inbox Angel worker.</p>
						<WriteButton className="mt-2" loading={setup.isPending} onClick={() => setup.mutate()}>
							Set up email routing
						</WriteButton>
					</CheckResult>
				)}

				{routing.destination_verified ? (
					<CheckResult status="pass" statusLabel="Verified" title="Email destination">
						<Code>{routing.admin_email}</Code> is verified as a Cloudflare Email Routing destination. Alerts and password resets will work.
					</CheckResult>
				) : (
					<CheckResult
						status="warn"
						statusLabel="Not verified"
						title="Email destination"
						summary={
							<>
								<Code>{routing.admin_email ?? 'Your email'}</Code> must be a Cloudflare Email Routing destination so Inbox Angel can send you alerts and password resets.
							</>
						}
					>
						<WriteButton loading={register.isPending} onClick={() => register.mutate()}>
							Register email destination
						</WriteButton>
						{routing.destination_debug ? <p className="mt-1 text-xs text-ink-2">Debug: {routing.destination_debug}</p> : null}
					</CheckResult>
				)}

				{nullFailed.length > 0 ? (
					<CheckResult
						status="error"
						title="Subdomain protection"
						summary={`The DNS lookup for the null-sender records failed (${dnsErrorDetail(nullFailed[0] ?? '')}).`}
						onRetry={onRetry}
					/>
				) : routing.null_sender_spf && routing.null_sender_dmarc ? (
					<CheckResult status="pass" statusLabel="Protected" title="Subdomain protection">
						<Code>{rd}</Code> has null-sender SPF and DMARC records, so it cannot be spoofed.
					</CheckResult>
				) : (
					<CheckResult
						status="warn"
						statusLabel="Unprotected"
						title="Subdomain protection"
						summary={
							<>
								Your reports subdomain <Code>{rd ?? 'reports.yourdomain.com'}</Code> lacks {nullMissing} records. Without them anyone can send email pretending to be from it.
							</>
						}
					>
						{routing.mx_found ? (
							<WriteButton loading={setup.isPending} onClick={() => setup.mutate()}>
								Add null-sender protection
							</WriteButton>
						) : null}
					</CheckResult>
				)}
			</CheckResultList>

			{error ? (
				<Alert variant="danger" title="That did not work">
					{error}
				</Alert>
			) : null}
			{info && !error ? <Alert variant="success">{info}</Alert> : null}

			{severity === 'good' ? (
				<p className="text-sm text-ink-2">Everything is connected. Reports arrive within 24 hours of your first mail flowing.</p>
			) : (
				<div>
					<Button variant="secondary" loading={retrying} onClick={onRetry}>
						<RefreshCw aria-hidden />
						Re-check
					</Button>
				</div>
			)}

			<StepNav onNext={onNext} onSkip={onSkip} nextLabel="Go to dashboard" showSkip={severity !== 'good'} />
		</StepCard>
	);
}
