import { Alert, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldHint, Label, Textarea } from '@inbox-angel/ui';
import { useId, useState } from 'react';
import type { HostedErrorInfo } from '../../lib/hosted';

/** Optional SPF source and MTA-STS choice, then enable. The error stays in the dialog so the form can be fixed. */
export function EnableDialog({
	open,
	onOpenChange,
	busy,
	error,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	busy: boolean;
	error: HostedErrorInfo | null;
	onSubmit: (body: { spf_record?: string; mta_sts?: boolean }) => void;
}) {
	const spfId = useId();
	const hintId = useId();
	const mtaId = useId();
	const [spf, setSpf] = useState('');
	const [mta, setMta] = useState(false);
	const blocked = error?.kind === 'full';
	return (
		<Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
			<DialogContent>
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						const record = spf.trim();
						onSubmit({ ...(record ? { spf_record: record } : {}), ...(mta ? { mta_sts: true } : {}) });
					}}
				>
					<DialogHeader>
						<DialogTitle>Enable hosted records</DialogTitle>
						<DialogDescription>Inbox Angel will publish your DMARC, SPF and TLS-RPT records. You add pointer records in your DNS once.</DialogDescription>
					</DialogHeader>
					<div className="space-y-1.5">
						<Label htmlFor={spfId}>SPF record (optional)</Label>
						<Textarea id={spfId} value={spf} onChange={(e) => setSpf(e.target.value)} aria-describedby={hintId} aria-invalid={error?.kind === 'input' ? true : undefined} placeholder="v=spf1 include:_spf.google.com -all" />
						<FieldHint id={hintId}>Leave empty to build it from the SPF record your domain publishes now.</FieldHint>
					</div>
					<div className="flex items-start gap-3">
						<Checkbox id={mtaId} checked={mta} onCheckedChange={(v) => setMta(v === true)} className="mt-0.5" />
						<div className="space-y-0.5">
							<Label htmlFor={mtaId}>Also host MTA-STS</Label>
							<FieldHint>Needs MX records. Inbox Angel serves the policy and keeps the MX list fresh.</FieldHint>
						</div>
					</div>
					{error ? (
						<Alert variant="danger" title={error.title}>
							{error.message}
						</Alert>
					) : null}
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
							Cancel
						</Button>
						<Button type="submit" loading={busy} disabled={blocked}>
							{busy ? 'Enabling…' : error?.retryable ? 'Retry' : 'Enable hosted records'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
