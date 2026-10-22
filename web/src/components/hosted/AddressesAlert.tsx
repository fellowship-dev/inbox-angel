import { Alert, Button } from '@inbox-angel/ui';
import { useEffect, useRef } from 'react';
import type { HostedAddresses } from '../../lib/hosted';
import { CopyField } from '../domain/CopyField';

/** The intake addresses, shown once. They live in component state only; dismissing drops them. */
export function AddressesAlert({ addresses, onDismiss }: { addresses: HostedAddresses; onDismiss: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<Alert ref={ref} tabIndex={-1} variant="warning" title="Your intake addresses are shown once, copy them now" data-testid="hosted-addresses">
			<p>We do not show these again. They are already published in your hosted records; keep them if you need them elsewhere.</p>
			<div className="mt-3 space-y-3">
				<CopyField label="DMARC reports (rua)" value={addresses.rua} />
				<CopyField label="TLS reports (tls_rpt)" value={addresses.tls_rpt} />
			</div>
			<Button variant="secondary" size="sm" className="mt-3" onClick={onDismiss}>
				I have copied them
			</Button>
		</Alert>
	);
}
