import { Button, CheckResult, CheckResultList } from '@inbox-angel/ui';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { SeverityBadge } from '../../../components/wizard/SeverityBadge';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepNav } from '../../../components/wizard/StepNav';
import { parseDmarcPolicy } from '../../../lib/dmarc-record';
import { matchDkimProvider, type EmailProvider } from '../../../lib/email-service-providers';
import type { StepProps } from './SpfStep';
import { dkimSeverity, dnsErrorDetail, dnsErrorsFor, unsignedProviders } from './steps';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function groupSelectors(selectors: { name: string; record: string }[]) {
	const signed = new Map<string, { provider: EmailProvider; selectors: string[] }>();
	const unknown: typeof selectors = [];
	for (const sel of selectors) {
		const provider = matchDkimProvider(sel.name);
		if (!provider) {
			unknown.push(sel);
			continue;
		}
		const prefix = sel.name.replace(/\._domainkey.*$/, '');
		const group = signed.get(provider.name);
		if (group) group.selectors.push(prefix);
		else signed.set(provider.name, { provider, selectors: [prefix] });
	}
	const groups = [...signed.values()];
	for (const g of groups) g.selectors.sort();
	return { groups, unknown };
}

export function DkimStep({ status, onNext, onSkip, onRetry, retrying }: StepProps) {
	const { dkim } = status;
	const dmarcPolicy = parseDmarcPolicy(status.dmarc.current_record);
	const selectorErrors = dnsErrorsFor(status, 'dkim');
	const spfFailed = dnsErrorsFor(status, 'spf').length > 0;
	const { groups, unknown } = groupSelectors(dkim.selectors);
	const unsigned = unsignedProviders(dkim, status.spf.record);
	const severity = dkimSeverity(dkim, dmarcPolicy, unsigned.length, selectorErrors.length > 0);
	const none = dkim.selectors.length === 0 && unsigned.length === 0;

	return (
		<StepCard title="DKIM signing" badge={<SeverityBadge severity={severity} />}>
			{groups.length > 0 ? (
				<section aria-label="Signing providers" className="space-y-2">
					<p className="text-sm text-ink-2">{plural(groups.length, 'signing provider')} detected.</p>
					<CheckResultList>
						{groups.map(({ provider, selectors }) => (
							<CheckResult key={provider.name} status="pass" statusLabel="Signing" title={provider.name} summary={`Selectors: ${selectors.join(', ')}`} />
						))}
					</CheckResultList>
				</section>
			) : null}

			{unsigned.length > 0 ? (
				<section aria-label="Providers without DKIM" className="space-y-2">
					<p className="text-sm text-ink-2">
						{plural(unsigned.length, 'provider')} in your SPF record {unsigned.length === 1 ? 'appears' : 'appear'} to be missing DKIM.
					</p>
					<CheckResultList>
						{unsigned.map((p) => (
							<CheckResult key={p.include || p.name} status="warn" statusLabel="No DKIM found" title={p.name}>
								{p.dkimGuideUrl ? (
									<a
										href={p.dkimGuideUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center gap-1 text-brand-ink underline underline-offset-4"
									>
										Set up DKIM
										<ExternalLink aria-hidden className="size-3.5" />
										<span className="sr-only">for {p.name} (opens in a new tab)</span>
									</a>
								) : null}
							</CheckResult>
						))}
					</CheckResultList>
				</section>
			) : null}

			{unknown.length > 0 ? (
				<section aria-label="Unrecognised selectors" className="space-y-2">
					<p className="text-sm text-ink-2">{plural(unknown.length, 'unrecognised selector')}.</p>
					<ul className="space-y-1.5">
						{unknown.map((sel) => (
							<li key={sel.name} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm [overflow-wrap:anywhere]">
								<code className="font-mono text-ink-1">{sel.name}</code>
								<span className="ml-2 font-mono text-xs text-ink-2">{sel.record.length > 60 ? `${sel.record.slice(0, 60)}…` : sel.record}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{selectorErrors.length > 0 ? (
				<CheckResultList>
					<CheckResult
						status="error"
						title="DKIM selector lookups"
						summary={`${plural(selectorErrors.length, 'selector lookup')} failed${none ? ', so we cannot say whether DKIM is set up' : ', so the list above may be incomplete'}.`}
						onRetry={onRetry}
					>
						<ul className="list-disc pl-5 font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">
							{selectorErrors.slice(0, 5).map((e) => (
								<li key={e}>
									{e.split(':')[0]?.replace(/^dkim /, '')}: {dnsErrorDetail(e)}
								</li>
							))}
						</ul>
					</CheckResult>
				</CheckResultList>
			) : null}

			{spfFailed ? (
				<CheckResultList>
					<CheckResult
						status="error"
						title="SPF record"
						summary="The SPF lookup failed, so we cannot tell which providers should be signing."
						onRetry={onRetry}
					/>
				</CheckResultList>
			) : null}

			{none && selectorErrors.length === 0 ? (
				<div className="space-y-2 text-sm text-ink-2">
					<p className="font-medium text-ink-1">No DKIM selectors found{dkim.source === 'doh' ? ' (checked common selectors)' : ''}.</p>
					{severity === 'warning' ? (
						<p>
							Your DMARC policy is <code className="font-mono text-ink-1">p={dmarcPolicy}</code> but mail lacks DKIM signatures. Without DKIM, some messages may fail DMARC
							alignment and be quarantined or rejected. Set up DKIM with your email provider before tightening your policy further.
						</p>
					) : (
						<p>
							DKIM is not required while DMARC is in monitoring mode, but you need it before moving to <code className="font-mono text-ink-1">p=quarantine</code> or{' '}
							<code className="font-mono text-ink-1">p=reject</code>. Set it up through your email provider (Google Workspace, Microsoft 365 and so on).
						</p>
					)}
				</div>
			) : null}

			<p className="text-sm text-ink-2">
				DKIM keys are generated in your email provider's dashboard, not in DNS directly. Once configured there, rescan to verify.
			</p>
			<div>
				<Button variant="secondary" onClick={onRetry} loading={retrying}>
					<RefreshCw aria-hidden />
					Rescan DNS
				</Button>
			</div>

			<StepNav onNext={onNext} onSkip={onSkip} showSkip={severity !== 'good'} />
		</StepCard>
	);
}
