import { Badge, CheckResult, CheckResultList } from '@inbox-angel/ui';
import { AlertTriangle, Check, Minus, ShieldCheck, X, XCircle } from 'lucide-react';
import { dkimAdvice, dmarcAdvice, overallMeta, protocolStatus, spfAdvice, spfStatus } from '../../lib/reports';
import type { CheckResult as CheckResultRow } from '../../lib/types';

const Record = ({ value }: { value: string }) => (
	<code className="block rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-ink-1 [overflow-wrap:anywhere]">{value}</code>
);

function Meta({ label, value }: { label: string; value: string }) {
	return (
		<p className="text-xs text-ink-2">
			{label}: <span className="font-mono">{value}</span>
		</p>
	);
}

/** SPF, DKIM and DMARC for one received test email. */
export function ProtocolResults({ result: r }: { result: CheckResultRow }) {
	const lookups = r.spf_lookup_count;
	return (
		<CheckResultList aria-label={`Results for ${r.from_domain}`}>
			<CheckResult
				title="SPF"
				status={spfStatus(r.spf_result, lookups)}
				summary={spfAdvice(r.spf_result, lookups)}
			>
				<div className="space-y-2">
					{lookups !== null ? <Meta label="DNS lookups" value={`${lookups}/10${lookups >= 10 ? ' (over the limit)' : lookups >= 8 ? ' (close to the limit)' : ''}`} /> : null}
					{r.spf_domain ? <Meta label="domain" value={r.spf_domain} /> : null}
					{r.spf_record ? <Record value={r.spf_record} /> : null}
				</div>
			</CheckResult>
			<CheckResult title="DKIM" status={protocolStatus(r.dkim_result)} summary={dkimAdvice(r.dkim_result)}>
				{r.dkim_domain ? <Meta label="domain" value={r.dkim_domain} /> : null}
			</CheckResult>
			<CheckResult title="DMARC" status={protocolStatus(r.dmarc_result)} summary={dmarcAdvice(r.dmarc_result, r.dmarc_policy, r.dmarc_record)}>
				{r.dmarc_record ? <Record value={r.dmarc_record} /> : null}
			</CheckResult>
		</CheckResultList>
	);
}

/** "Protected" / "At risk" / "Exposed" with an icon. */
export function OverallBadge({ status }: { status: string }) {
	const { label, variant } = overallMeta(status);
	const Icon = variant === 'success' ? ShieldCheck : variant === 'warning' ? AlertTriangle : XCircle;
	return (
		<Badge variant={variant}>
			<Icon aria-hidden />
			{label}
		</Badge>
	);
}

/** Compact "SPF pass" chip for list rows. */
export function ProtocolChip({ name, result }: { name: string; result: string | null }) {
	const status = protocolStatus(result);
	const Icon = status === 'pass' ? Check : status === 'missing' ? Minus : X;
	const word = status === 'pass' ? 'pass' : status === 'missing' ? 'none' : status === 'warn' ? 'warn' : 'fail';
	const tone = status === 'pass' ? 'text-success' : status === 'missing' ? 'text-ink-2' : status === 'warn' ? 'text-warning' : 'text-danger';
	return (
		<span className={`inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
			<Icon aria-hidden className="size-3.5" />
			{name} {word}
		</span>
	);
}

