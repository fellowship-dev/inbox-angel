import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@inbox-angel/ui';
import type { ReactNode } from 'react';

/** Confirmation before something that changes DNS or deletes data. The error stays inside the dialog. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
	confirmLabel,
	busyLabel,
	variant = 'primary',
	busy,
	error,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	confirmLabel: string;
	busyLabel?: string;
	variant?: 'primary' | 'danger';
	busy: boolean;
	error?: string | null;
	onConfirm: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description ? <DialogDescription>{description}</DialogDescription> : null}
				</DialogHeader>
				{children}
				{error ? (
					<Alert variant="danger" title="That did not work">
						{error}
					</Alert>
				) : null}
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
						Cancel
					</Button>
					<Button variant={variant} loading={busy} onClick={onConfirm}>
						{busy && busyLabel ? busyLabel : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
