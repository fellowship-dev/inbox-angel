import { Badge } from '@inbox-angel/ui';
import { AlertTriangle, CheckCircle2, CircleHelp, Info, XCircle } from 'lucide-react';

/** `unknown` = the DNS lookup behind this step failed, so we cannot judge it. */
export type Severity = 'good' | 'info' | 'warning' | 'error' | 'unknown';

const META = {
	good: { label: 'All good', variant: 'success', Icon: CheckCircle2 },
	info: { label: 'Info', variant: 'brand', Icon: Info },
	warning: { label: 'Needs attention', variant: 'warning', Icon: AlertTriangle },
	error: { label: 'Action required', variant: 'danger', Icon: XCircle },
	unknown: { label: 'Lookup failed', variant: 'neutral', Icon: CircleHelp },
} as const;

export const severityLabel = (s: Severity): string => META[s].label;

export function SeverityBadge({ severity }: { severity: Severity }) {
	const { label, variant, Icon } = META[severity];
	return (
		<Badge variant={variant}>
			<Icon aria-hidden />
			{label}
		</Badge>
	);
}
