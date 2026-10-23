import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldError, Input } from '@inbox-angel/ui';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';
import { setupSeenKey } from '../lib/workspace';
import { switchToWorkspace, useCreateWorkspace } from '../lib/workspaces';
import { Field } from '../pages/auth/AuthLayout';

/** Name it, create it (you become its owner), and open it. */
export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [name, setName] = useState('');
	const create = useCreateWorkspace((w) => {
		// A workspace you just made starts at its own empty state, not at the first-run wizard.
		sessionStorage.setItem(setupSeenKey(w.id), '1');
		setName('');
		onOpenChange(false);
		switchToWorkspace(w.id);
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		if (name.trim()) create.mutate(name.trim());
	}

	return (
		<Dialog open={open} onOpenChange={(o) => (create.isPending ? undefined : onOpenChange(o))}>
			<DialogContent>
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Create workspace</DialogTitle>
						<DialogDescription>
							A workspace keeps its own domains, reports, members and Cloudflare connections. You will be its owner; invite people from its Members page.
						</DialogDescription>
					</DialogHeader>
					<Field id="workspace-name" label="Workspace name">
						<Input id="workspace-name" required autoFocus maxLength={80} placeholder="Lexgo" value={name} onChange={(e) => setName(e.target.value)} />
					</Field>
					{create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" loading={create.isPending} disabled={!name.trim()}>
							Create workspace
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
