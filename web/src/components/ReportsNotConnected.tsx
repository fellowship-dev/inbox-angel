import { StatusDot, cn } from '@ready-set-mail/ui';
import { hasReportAddress } from '../lib/dmarc-record';
import { useDomains } from '../lib/queries';
import { useHosted } from '../lib/session';
import { HELP_PRIORITY, TalkToMax } from './TalkToMax';
import { ConnectReports } from './reports/ConnectReports';

/**
 * Hosted only: a domain whose DMARC reports cannot reach this dashboard, because it has no report address (hosted
 * report intake is not connected). Report screens then say so instead of showing empty charts or "nothing failing".
 * Always false on a self-hosted instance, whose screens stay as they are.
 */
export function useReportsNotConnected(domain: { rua_address?: string | null } | null | undefined): boolean {
	const hosted = useHosted();
	return hosted && !!domain && !hasReportAddress(domain.rua_address);
}

/** Hosted only: no domain in this workspace has a report address, so workspace-wide report views have nothing to show. */
export function useWorkspaceReportsNotConnected(): boolean {
	const hosted = useHosted();
	const domains = useDomains();
	return hosted && !!domains.data && domains.data.every((d) => !hasReportAddress(d.rua_address));
}

/**
 * "Reports not connected yet", in place of report data: what that means, what still works from live DNS, and a
 * person to talk to. Status "unknown" (dashed circle), never a pass: without reports nobody can say every sender passes.
 * With `domainId` (one domain) and report intake on, it also offers Connect reports (ConnectReports `bare`: the action only).
 */
export function ReportsNotConnected({ domain, domainId, className }: { domain?: string; domainId?: number; className?: string }) {
	return (
		<section aria-label="Reports" className={cn('space-y-2 rounded-lg border border-line bg-surface-2 p-4 sm:p-5', className)} data-testid="reports-not-connected">
			<StatusDot status="unknown" label="Reports not connected yet" className="font-semibold" />
			<p className="text-sm text-ink-2">
				Mail servers send DMARC reports to the address listed in a domain&apos;s DMARC record. {domain ? <strong className="font-mono font-medium text-ink-1 [overflow-wrap:anywhere]">{domain}</strong> : 'Your domains'}{' '}
				{domain ? 'has' : 'have'} no Ready Set Mail report address yet, so no reports arrive here. Until they do, nobody can confirm that every sender passes: pass rates, failing
				senders and whether it is safe to enforce cannot be shown.
			</p>
			<p className="text-sm text-ink-2">Still checked from live DNS: your SPF, DKIM and DMARC records, each domain&apos;s level, and the exact records to fix.</p>
			{domain && domainId !== undefined ? <ConnectReports domain={{ id: domainId, domain }} bare /> : null}
			<TalkToMax priority={HELP_PRIORITY.reportsNotConnected} lead="Want reports for your domains?" about="about connecting them" />
		</section>
	);
}
