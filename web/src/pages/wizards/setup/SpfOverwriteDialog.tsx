import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@inbox-angel/ui';
import { RecordPair, TxtRecord } from '../../../components/wizard/RecordPair';

export interface SpfOverwrite {
	existing: string;
	proposed: string;
}

/** Replaces window.confirm: shows what is in DNS now next to what we would write, and needs an explicit yes. */
export function SpfOverwriteDialog({
	overwrite,
	busy,
	error,
	onConfirm,
	onCancel,
}: {
	overwrite: SpfOverwrite | null;
	busy: boolean;
	error: string | null;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<Dialog open={overwrite !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Replace the existing SPF record?</DialogTitle>
					<DialogDescription>
						A different SPF record is already published in DNS. Applying replaces it. A domain can only have one SPF record, so the two cannot coexist.
					</DialogDescription>
				</DialogHeader>
				{overwrite ? (
					<RecordPair>
						<TxtRecord title="Existing record in DNS" value={overwrite.existing} />
						<TxtRecord title="Proposed record" value={overwrite.proposed} />
					</RecordPair>
				) : null}
				{error ? (
					<Alert variant="danger" title="Could not replace the record">
						{error}
					</Alert>
				) : null}
				<DialogFooter>
					<Button variant="secondary" onClick={onCancel} disabled={busy}>
						Keep the existing record
					</Button>
					<Button onClick={onConfirm} loading={busy}>
						Replace with the proposed record
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
