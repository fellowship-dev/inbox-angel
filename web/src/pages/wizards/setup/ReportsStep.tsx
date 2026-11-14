import { Badge } from '@ready-set-mail/ui';
import { CircleDashed } from 'lucide-react';
import { ReportsNotConnected } from '../../../components/ReportsNotConnected';
import { ConnectReports } from '../../../components/reports/ConnectReports';
import { useReportIntakeEnabled } from '../../../lib/report-address';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepNav } from '../../../components/wizard/StepNav';
import type { StepProps } from './SpfStep';

/**
 * Hosted replacement for the Routing step. Email Routing and the routing destination are self-host only (the hosted
 * service answers 404). When this server takes hosted reports, the step offers Connect reports and then shows what to
 * publish and how far it has got; otherwise it says plainly that reports are not connected and lets the person finish.
 */
export function ReportsStep({ status, onNext }: StepProps) {
	const intake = useReportIntakeEnabled();
	if (intake) {
		return (
			<StepCard title="DMARC reports">
				<ConnectReports domain={{ id: status.domain_id, domain: status.domain }} headless />
				<StepNav onNext={onNext} nextLabel="Go to dashboard" showSkip={false} />
			</StepCard>
		);
	}
	return (
		<StepCard
			title="DMARC reports"
			badge={
				<Badge variant="neutral">
					<CircleDashed aria-hidden />
					Not connected
				</Badge>
			}
		>
			<ReportsNotConnected domain={status.domain} />
			<StepNav onNext={onNext} nextLabel="Go to dashboard" showSkip={false} />
		</StepCard>
	);
}
