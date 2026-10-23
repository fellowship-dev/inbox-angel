import { Badge } from '@inbox-angel/ui';
import { ShieldAlert } from 'lucide-react';

export const UNAUTHENTICATED_TIP = 'The report email did not pass DMARC-aligned authentication, so treat it as unverified.';

/** Flags reports whose delivery email failed authentication ('fail' / 'none'). Old reports (null) and 'pass' show nothing. */
export function ReporterAuthBadge({ auth }: { auth: 'pass' | 'fail' | 'none' | null | undefined }) {
	if (auth !== 'fail' && auth !== 'none') return null;
	return (
		<Badge variant="warning" title={UNAUTHENTICATED_TIP} className="ml-2 align-middle">
			<ShieldAlert aria-hidden />
			unauthenticated sender
			<span className="sr-only">: {UNAUTHENTICATED_TIP}</span>
		</Badge>
	);
}
