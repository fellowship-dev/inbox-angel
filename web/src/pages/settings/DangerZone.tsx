import { Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldError, Input, toast } from '@inbox-angel/ui';
import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Section } from '../../components/states';
import { api, ApiError, errorMessage, tokenStore } from '../../lib/api';
import { downloadFile } from '../../lib/download';
import { useSession } from '../../lib/session';
import { Field } from '../auth/AuthLayout';

interface Blocking {
	id: string;
	name: string;
	members: number;
}

/** Export the workspace's data (owners); delete your own account (everyone signed in as a user). */
export function DangerZone() {
	const { me, role } = useSession();
	if (!me?.user) return null;
	return (
		<Section title="Danger zone" description="Take your data with you, or delete your account.">
			{role === 'owner' ? <ExportCard workspaceId={me.workspace_id} /> : null}
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
					<div className="min-w-0 max-w-xl">
						<h3 className="font-semibold">Delete my account</h3>
						<p className="text-sm text-ink-2">
							Removes your login, sessions, API keys and memberships, and any workspace only you belong to (with its domains, reports and Cloudflare access). If you are the only owner of a workspace that
							has other members, transfer ownership first.
						</p>
					</div>
					<DeleteAccount email={me.user.email} />
				</CardContent>
			</Card>
		</Section>
	);
}

function ExportCard({ workspaceId }: { workspaceId: string }) {
	const download = useMutation({
		mutationFn: () => downloadFile(`/api/workspaces/${encodeURIComponent(workspaceId)}/export`, `inbox-angel-${workspaceId}-export.json`),
		onError: (e) => toast({ variant: 'danger', title: 'Could not export', description: errorMessage(e) }),
	});
	return (
		<Card>
			<CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
				<div className="min-w-0 max-w-xl">
					<h3 className="font-semibold">Export this workspace's data</h3>
					<p className="text-sm text-ink-2">Everything it holds, as one JSON file: members, domains, reports, settings and the audit log. Secrets and raw report payloads are left out.</p>
				</div>
				<Button variant="secondary" loading={download.isPending} onClick={() => download.mutate()}>
					<Download aria-hidden />
					Download JSON
				</Button>
			</CardContent>
		</Card>
	);
}

function DeleteAccount({ email }: { email: string }) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState('');
	const del = useMutation({
		mutationFn: () => api('/api/account', { method: 'DELETE', body: { confirm: typed } }),
		onSuccess: () => {
			toast({ variant: 'success', title: 'Your account was deleted' });
			tokenStore.clear();
			window.location.hash = '#/';
			window.location.reload();
		},
	});
	const blocking = del.error instanceof ApiError ? ((del.error.body as { code?: string; workspaces?: Blocking[] } | undefined)?.workspaces ?? null) : null;
	const matches = typed.trim().toLowerCase() === email.toLowerCase();
	return (
		<>
			<Button variant="danger" onClick={() => setOpen(true)}>
				Delete my account
			</Button>
			<Dialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) {
						setTyped('');
						del.reset();
					}
				}}
			>
				<DialogContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							del.mutate();
						}}
						className="space-y-4"
					>
						<DialogHeader>
							<DialogTitle>Delete your account?</DialogTitle>
							<DialogDescription>This cannot be undone. Workspaces only you belong to are deleted with their data, and their Cloudflare access is revoked.</DialogDescription>
						</DialogHeader>
						<Field id="confirm-account-delete" label={`Type your email, ${email}, to confirm`}>
							<Input id="confirm-account-delete" type="email" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
						</Field>
						{blocking ? (
							<div role="alert" className="space-y-1 text-sm text-danger">
								<p>You are the only owner of {blocking.map((b) => `"${b.name}"`).join(', ')}, which still ha{blocking.length === 1 ? 's' : 've'} other members.</p>
								<p>Transfer ownership on the Members page (or delete the workspace), then try again.</p>
							</div>
						) : del.isError ? (
							<FieldError>{errorMessage(del.error)}</FieldError>
						) : null}
						<DialogFooter>
							<Button type="button" variant="secondary" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="danger" loading={del.isPending} disabled={!matches}>
								Delete my account
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
