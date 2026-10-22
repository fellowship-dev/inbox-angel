import { Badge } from '@inbox-angel/ui';
import { CheckCircle2, XCircle } from 'lucide-react';

/** "SPF pass" / "DKIM fail": icon and word, never colour alone. */
export function AuthBadge({ protocol, pass }: { protocol: 'SPF' | 'DKIM'; pass: boolean }) {
	return (
		<Badge variant={pass ? 'success' : 'danger'}>
			{pass ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
			{protocol} {pass ? 'pass' : 'fail'}
		</Badge>
	);
}
