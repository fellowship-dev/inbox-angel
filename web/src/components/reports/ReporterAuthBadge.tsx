import { Badge } from '@inbox-angel/ui';
import { ShieldAlert } from 'lucide-react';

export const UNAUTHENTICATED_TIP = 'The report email did not pass DMARC-aligned authentication, so treat it as unverified.';

export const NOT_COUNTED = 'not counted in your numbers';

/** Flags reports whose delivery email failed authentication ('fail' / 'none'), and any report that does not feed the numbers. */
export function ReporterAuthBadge({ auth, counted }: { auth: 'pass' | 'fail' | 'none' | null | undefined; counted?: boolean }) {
	const notCounted = counted === false ? <span className="ml-2 align-middle text-xs text-ink-2">{NOT_COUNTED}</span> : null;
	if (auth !== 'fail' && auth !== 'none') return notCounted;
	return (<>
		<Badge variant="warning" title={UNAUTHENTICATED_TIP} className="ml-2 align-middle">
			<ShieldAlert aria-hidden />
			unauthenticated sender
			<span className="sr-only">: {UNAUTHENTICATED_TIP}</span>
		</Badge>
		{notCounted}
	</>);
}
