import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@inbox-angel/ui';
import { CheckCircle2, Sparkles, XCircle, AlertTriangle } from 'lucide-react';
import { fmtPct, senderName, type Alignment, type Sender } from '../../lib/analytics';
import { formatNumber } from '../../lib/format';
import { formatDay, isoDay } from '../../lib/reports';

/** Scroll shadows at the table's edges (they show only while there is more to scroll to), so a cut-off column is never silent. */
const SCROLL_SHADOWS =
	'[background-image:linear-gradient(to_right,var(--surface-1),var(--surface-1)),linear-gradient(to_left,var(--surface-1),var(--surface-1)),linear-gradient(to_right,rgb(0_0_0/0.22),transparent),linear-gradient(to_left,rgb(0_0_0/0.22),transparent)] [background-position:left_center,right_center,left_center,right_center] [background-repeat:no-repeat] [background-size:2rem_100%,2rem_100%,0.9rem_100%,0.9rem_100%] [background-attachment:local,local,scroll,scroll]';

/** A rate with an icon and the number, so pass/partial/fail never rests on colour. */
function Rate({ pct, label }: { pct: number; label: string }) {
	const Icon = pct >= 95 ? CheckCircle2 : pct >= 50 ? AlertTriangle : XCircle;
	const word = pct >= 95 ? 'passing' : pct >= 50 ? 'partly passing' : 'failing';
	return (
		<span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
			<Icon aria-hidden className={pct >= 95 ? 'size-4 text-success' : pct >= 50 ? 'size-4 text-warning' : 'size-4 text-danger'} />
			{fmtPct(pct)}
			<span className="sr-only">
				{' '}
				{label} aligned, {word}
			</span>
		</span>
	);
}

/** Every source that sent as this domain: who it is, how much, whether SPF and DKIM line up, and when it appeared. */
export function SenderInventory({ senders, showDomains, alignment }: { senders: Sender[]; showDomains?: boolean; alignment?: Alignment }) {
	if (senders.length === 0) {
		return <EmptyState title="No senders in this window" description="Senders appear once receivers report mail sent as your domain." />;
	}
	return (
		<div className="space-y-2">
			<p className="text-xs text-ink-2 sm:hidden">Scroll sideways to see every column.</p>
			<Table label="Sender inventory" containerClassName={SCROLL_SHADOWS}>
				<caption className="sr-only">Sender inventory</caption>
				<TableHeader>
					<TableRow>
						<TableHead scope="col">Sender</TableHead>
						<TableHead scope="col" className="text-right">Volume</TableHead>
						<TableHead scope="col">SPF aligned (est.)</TableHead>
						<TableHead scope="col">DKIM aligned (est.)</TableHead>
						<TableHead scope="col">Seen</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{senders.map((s) => (
						<TableRow key={s.source_ip}>
							<TableCell className="max-w-72">
								<span className="flex min-w-0 flex-col">
									<span className="flex flex-wrap items-center gap-2 font-semibold text-ink-1 [overflow-wrap:anywhere]">
										{senderName(s)}
										{s.is_new ? (
											<Badge variant="brand">
												<Sparkles aria-hidden />
												New sender
											</Badge>
										) : null}
										{s.dmarc_pass_pct < 50 ? (
											<Badge variant="danger">
												<XCircle aria-hidden />
												Likely failing
											</Badge>
										) : null}
									</span>
									<code className="font-mono text-xs text-ink-2">{s.source_ip}</code>
									{s.provider ? null : s.reverse_dns || s.org ? <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">{[s.reverse_dns, s.org].filter(Boolean).join(' · ')}</span> : null}
									{s.provider && (s.reverse_dns || s.org) ? <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">{[s.reverse_dns, s.org].filter(Boolean).join(' · ')}</span> : null}
									{showDomains ? <span className="text-xs text-ink-2">as {s.domains.join(', ')}</span> : null}
								</span>
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{formatNumber(s.messages)}
								<span className="block text-xs text-ink-2">{fmtPct(s.share_pct)} of mail</span>
							</TableCell>
							<TableCell><Rate pct={s.spf_aligned_pct} label="SPF" /></TableCell>
							<TableCell><Rate pct={s.dkim_aligned_pct} label="DKIM" /></TableCell>
							<TableCell className="whitespace-nowrap text-xs">
								<span className="block">First: {formatDay(isoDay(s.first_seen))}</span>
								<span className="block">Last: {formatDay(isoDay(s.last_seen))}</span>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			<p className="text-xs text-ink-2">
				<strong className="font-semibold">These alignment figures are estimates.</strong> Reports keep each message's raw SPF and DKIM results, not the receiver's DMARC verdict, so we work alignment out from the domains they authenticated. Mail signed twice (by the sender's domain and by yours) can read as failing here although DMARC passed it.{' '}
				{alignment ? (alignment.spf === 'strict' || alignment.dkim === 'strict' ? `Checked with ${alignment.spf} SPF and ${alignment.dkim} DKIM alignment, from your published DMARC record.` : alignment.basis === 'dns' ? 'Checked with relaxed alignment, as your published DMARC record asks.' : 'Checked with relaxed alignment only: we could not read your record, so adkim=s / aspf=s would not be applied.') : 'Checked with relaxed alignment only: adkim=s / aspf=s are not applied.'}{' '}
				The pass-rate trend and totals come from the reports' own DMARC results and are exact. "First seen" looks back at most 180 days.
			</p>
		</div>
	);
}
