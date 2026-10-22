import { Alert, Badge } from '@inbox-angel/ui';
import { AlertTriangle, CheckCircle2, Info, ShieldCheck, XCircle } from 'lucide-react';
import { READINESS_LABEL, fmtPct, type Readiness } from '../../lib/analytics';

const TONE = { ready: 'success', caution: 'warning', blocked: 'danger', insufficient_data: 'info', complete: 'success', no_policy: 'info' } as const;
const REASON_ICON = { ok: CheckCircle2, warn: AlertTriangle, block: XCircle } as const;
const REASON_WORD = { ok: 'OK', warn: 'Careful', block: 'Blocker' } as const;

/** Whether the next RFC 9989 step is safe, with the reasons: each carries an icon and a word, never colour alone. */
export function ReadinessCard({ readiness: r }: { readiness: Readiness }) {
	const StatusIcon = r.status === 'ready' || r.status === 'complete' ? ShieldCheck : r.status === 'blocked' ? XCircle : r.status === 'caution' ? AlertTriangle : Info;
	return (
		<Alert variant={TONE[r.status]} title={r.headline}>
			<div className="space-y-3">
				<p className="flex flex-wrap items-center gap-2 text-sm">
					<Badge variant={TONE[r.status] === 'info' ? 'outline' : (TONE[r.status] as 'success' | 'warning' | 'danger')}>
						<StatusIcon aria-hidden />
						{READINESS_LABEL[r.status]}
					</Badge>
					<span>
						Now: <code>{r.current.label}</code> (step {r.current.step + 1} of {r.total_steps})
					</span>
					{r.next ? (
						<span>
							Next: <code>{r.next.label}</code>
						</span>
					) : null}
				</p>
				<ul className="space-y-1.5 text-sm">
					{r.reasons.map((x) => {
						const Icon = REASON_ICON[x.level];
						return (
							<li key={x.text} className="flex items-start gap-2">
								<Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
								<span>
									<span className="sr-only">{REASON_WORD[x.level]}: </span>
									{x.text}
								</span>
							</li>
						);
					})}
				</ul>
				<p className="text-xs text-ink-2">
					Based on the last {r.metrics.window_days} days{r.metrics.pass_rate !== null ? ` (${fmtPct(r.metrics.pass_rate)} pass rate)` : ''} and the {r.policy_source === 'dns' ? 'policy published in DNS right now' : 'last known policy (the live DNS lookup failed)'}. Advice only: the rollout wizard makes the change.
				</p>
			</div>
		</Alert>
	);
}
