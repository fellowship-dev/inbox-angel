import { Badge } from '@ready-set-mail/ui';
import { ShieldAlert } from 'lucide-react';

export const UNKNOWN_SENDER_TIP = 'The report email was authenticated, but its sender is not on the list of known reporters, so the report is stored and not counted.';
export const UNAUTHENTICATED_TIP = 'The report email could not be authenticated, so treat it as unverified.';
export const NOT_COUNTED = 'not counted in your numbers';

/** Flags reports from senders we do not recognise or could not authenticate, and any report that does not feed the numbers. */
export function ReporterAuthBadge({ tier, counted }: { tier?: 'counted' | 'unknown' | 'unauthenticated' | null; counted?: boolean }) {
	const notCounted = counted === false ? <span className="ml-2 align-middle text-xs text-ink-2">{NOT_COUNTED}</span> : null;
	if (tier !== 'unknown' && tier !== 'unauthenticated') return notCounted;
	const tip = tier === 'unknown' ? UNKNOWN_SENDER_TIP : UNAUTHENTICATED_TIP;
	return (<>
		<Badge variant="warning" title={tip} className="ml-2 align-middle">
			<ShieldAlert aria-hidden />
			{tier === 'unknown' ? 'sender not recognised' : 'unauthenticated sender'}
			<span className="sr-only">: {tip}</span>
		</Badge>
		{notCounted}
	</>);
}
