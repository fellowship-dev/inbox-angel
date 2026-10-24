import { Alert, Button, Input } from '@inbox-angel/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { workspaceStore } from '../../lib/workspace';
import { AuthLayout } from './AuthLayout';

/**
 * Signed in and verified, but in no workspace yet: someone who signed up through an invite link. They have no workspace
 * of their own; the invitations addressed to their verified email are offered here.
 */
export function NoWorkspacePage() {
	const { me, signedIn, signOut } = useSession();
	const invites = me?.pending_invites ?? [];
	const accept = useMutation({
		mutationFn: (token: string) => api(`/api/invites/${token}`, { method: 'POST', body: {} }),
		onSuccess: async () => {
			workspaceStore.forget();
			await signedIn();
		},
	});
	const [name, setName] = useState('');
	const create = useMutation({
		mutationFn: () => api('/api/workspaces', { method: 'POST', body: { name: name.trim() || 'My workspace' }, workspace: null }),
		onSuccess: async () => {
			workspaceStore.forget();
			await signedIn();
		},
	});
	return (
		<AuthLayout title={invites.length ? 'You have been invited' : 'No workspace yet'}>
			{invites.length === 0 ? (
				<Alert variant="warning" title="There is no invitation waiting for this address">
					Ask the person who invited you for a new link, or create a workspace of your own below.
				</Alert>
			) : (
				<ul className="space-y-3">
					{invites.map((i) => (
						<li key={i.token} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
							<span>
								<strong>{i.workspace_name ?? 'A workspace'}</strong>
								<span className="block text-sm text-muted-foreground">
									as {i.role}, invited by {i.invited_by}
								</span>
							</span>
							<Button onClick={() => accept.mutate(i.token)} loading={accept.isPending && accept.variables === i.token}>
								Accept
							</Button>
						</li>
					))}
				</ul>
			)}
			<form
				className="space-y-2"
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate();
				}}
			>
				<label htmlFor="workspace-name" className="text-sm font-medium">
					Or start a workspace of your own
				</label>
				<Input id="workspace-name" placeholder="My workspace" value={name} onChange={(e) => setName(e.target.value)} />
				<Button type="submit" variant="secondary" className="w-full" loading={create.isPending}>
					Create workspace
				</Button>
			</form>
			{create.isError ? <Alert variant="danger">{errorMessage(create.error)}</Alert> : null}
			{accept.isError ? <Alert variant="danger">{errorMessage(accept.error)}</Alert> : null}
			<Button variant="secondary" className="w-full" onClick={() => void signOut()}>
				Sign out
			</Button>
		</AuthLayout>
	);
}
