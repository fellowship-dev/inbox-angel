import { Badge } from '@ready-set-mail/ui';
import { CircleDashed } from 'lucide-react';
import { ReportsNotConnected } from '../../../components/ReportsNotConnected';
import { StepCard } from '../../../components/wizard/StepCard';
import { StepNav } from '../../../components/wizard/StepNav';
import type { StepProps } from './SpfStep';

/**
 * Hosted replacement for the Routing step. It calls nothing: Email Routing and the routing destination are
 * self-host only (the hosted service answers 404), and hosted report intake is not connected. It says so plainly
 * and lets the person finish; the records checked in the steps before keep working from live DNS.
 */
export function ReportsStep({ status, onNext }: StepProps) {
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
