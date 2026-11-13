import { Badge, Card, CardContent, EmptyState, RecordBlock } from '@ready-set-mail/ui';
import { CheckCircle2, ExternalLink, Inbox } from 'lucide-react';
import { Link } from 'react-router';
import { fmtPct, SEVERITY_LABEL, type Fix } from '../../lib/analytics';
import { formatNumber } from '../../lib/format';

const VARIANT = { high: 'danger', medium: 'warning', low: 'outline' } as const;

/**
 * What to fix next, most impactful first: the sender, the share it touches, and the change to make.
 * `messages` is how many reported messages the list was built from: with none, there is no evidence either way.
 */
export function FixList({ fixes, messages, showDomain }: { fixes: Fix[]; messages: number; showDomain?: boolean }) {
	if (fixes.length === 0 && messages === 0) {
		return <EmptyState icon={<Inbox />} title="No reports yet" description="There are no DMARC reports for this period, so there is nothing to rank yet." />;
	}
	if (fixes.length === 0) {
		return <EmptyState icon={<CheckCircle2 />} title="Nothing to fix right now" description="Every sender we can see passes DMARC, or the failures are too small to act on." />;
	}
	return (
		<ol aria-label="What to fix next" className="space-y-4">
			{fixes.map((f, i) => (
				<li key={f.id}>
					<Card>
						<CardContent className="space-y-3">
							<div className="flex flex-wrap items-start justify-between gap-2">
								<h3 className="min-w-0 text-base font-semibold text-ink-1">
									<span className="mr-2 text-ink-2">{i + 1}.</span>
									{f.title}
								</h3>
								<Badge variant={VARIANT[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
							</div>
							<p className="text-sm text-ink-2">
								{showDomain ? (
									<>
										<Link className="text-brand-ink underline underline-offset-4" to={`/domains/${f.domain_id}/analytics`}>
											{f.domain}
										</Link>
										{' · '}
									</>
								) : null}
								Sends {fmtPct(f.share_pct)} of mail
								{f.affected_messages > 0 ? `; ${formatNumber(f.affected_messages)} messages (${fmtPct(f.affected_pct)}) affected` : ''}.
							</p>
							<p className="text-sm">{f.detail}</p>
							<ol className="list-decimal space-y-1 pl-5 text-sm">
								{f.steps.map((s) => (
									<li key={s}>{s}</li>
								))}
							</ol>
							{f.records.map((r) => (
								<RecordBlock key={`${r.type}${r.name}`} record={r} title={r.type === 'TXT' ? 'Replace your SPF record with this' : 'Add this record'} />
							))}
							{f.guide_url ? (
								<a className="inline-flex items-center gap-1 text-sm text-brand-ink underline underline-offset-4" href={f.guide_url} target="_blank" rel="noreferrer">
									{f.sender.name} setup guide
									<ExternalLink aria-hidden className="size-3.5" />
									<span className="sr-only"> (opens in a new tab)</span>
								</a>
							) : null}
						</CardContent>
					</Card>
				</li>
			))}
		</ol>
	);
}
