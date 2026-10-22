import { Alert } from '@inbox-angel/ui';
import { inheritanceVerdict } from '../../lib/dmarc';
import type { ParentContext } from '../../lib/types';

/** What a new subdomain inherits from its parent: DMARC yes (via p=/sp=), SPF and DKIM no. */
export function InheritanceBanner({ pc, subdomain }: { pc: ParentContext; subdomain: string }) {
	const v = inheritanceVerdict(pc);
	return (
		<section className="space-y-3" aria-label="Subdomain inheritance">
			<h2 className="text-lg font-semibold tracking-tight">
				Subdomain of <span className="font-mono">{pc.domain}</span>: inheritance summary
			</h2>
			{v.kind === 'none' ? (
				<Alert variant="warning" title="DMARC: parent has no record">
					No DMARC record found on {pc.domain}. Consider setting up {pc.domain} first, then return here.
				</Alert>
			) : v.kind === 'enforced' ? (
				<Alert variant="success" title="DMARC: already protected by the parent">
					{pc.domain} enforces {v.via}, so this subdomain is already protected by the parent&apos;s policy. We still recommend adding an explicit{' '}
					<code>_dmarc.{subdomain}</code> record for independent control.
				</Alert>
			) : (
				<Alert variant="warning" title="DMARC: the parent does not enforce reject for subdomains">
					{pc.domain} does not enforce a subdomain reject policy ({v.via}). This subdomain can be spoofed. Add the DMARC record below to protect it independently.
				</Alert>
			)}
			<Alert variant="info" title="SPF does not inherit">
				{subdomain} needs its own SPF record.
			</Alert>
			<Alert variant="info" title="DKIM does not inherit">
				Check with your email provider for subdomain signing setup.
			</Alert>
		</section>
	);
}
