import { Alert, Badge, Button, FieldError, Input, Skeleton } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { hashFor, workspaceStore } from '../../lib/workspace';
import { CheckEmail } from './CheckEmail';
import { AuthLayout, Field } from './AuthLayout';

interface InviteInfo {
	email: string;
	invited_by: string;
	role: string;
	workspace_id: string;
	workspace_name: string | null;
	/** The email already has a login: accepting adds a membership, no password form. */
	user_exists: boolean;
	signed_in_as: string | null;
}

export function InvitePage() {
	const { token = '' } = useParams();
	const { signedIn, signOut } = useSession();
	const navigate = useNavigate();
	const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api<InviteInfo>(`/api/invites/${token}`), retry: false });
	const [name, setName] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [verifyFor, setVerifyFor] = useState<string | null>(null);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		if (password.length < 8) return setError('Password must be at least 8 characters.');
		if (password !== confirm) return setError('Passwords do not match.');
		setBusy(true);
		try {
			const res = await api<{ verification_required?: boolean }>(`/api/invites/${token}`, { method: 'POST', body: { name: name.trim(), password } });
			if (res.verification_required) {
				setVerifyFor(invite.data?.email ?? '');
				return;
			}
			await signedIn();
			// The new login's first workspace is the one they were invited to.
			workspaceStore.forget();
			navigate('/', { replace: true });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (verifyFor) return <CheckEmail email={verifyFor} note="Confirm your email address and choose your password from the link we sent. Then open this invite link again, signed in, to join the workspace." />;

	if (invite.isPending) {
		return (
			<AuthLayout title="Loading invite">
				<div aria-busy="true" role="status" className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<span className="sr-only">Loading invite…</span>
				</div>
			</AuthLayout>
		);
	}
	if (invite.isError) {
		// 404 is "no such invite / used / expired"; anything else is a failure to ask.
		const gone = invite.error instanceof ApiError && invite.error.status === 404;
		return (
			<AuthLayout title={gone ? 'Invite not found' : 'Could not load the invite'}>
				<Alert variant={gone ? 'warning' : 'danger'}>{gone ? 'This invite link is invalid or has expired. Ask the person who invited you for a new one.' : errorMessage(invite.error)}</Alert>
				{!gone ? (
					<Button variant="secondary" onClick={() => invite.refetch()}>
						Try again
					</Button>
				) : null}
				<Link to="/" className="text-sm text-brand-ink underline underline-offset-4">
					Go to the dashboard
				</Link>
			</AuthLayout>
		);
	}
	const info = invite.data;
	const workspaceLabel = info.workspace_name ?? 'a workspace';
	const description = (
		<>
			<strong>{info.invited_by}</strong> invited you to join <strong>{workspaceLabel}</strong> on Inbox Angel as <Badge variant="brand">{info.role}</Badge>
		</>
	);

	if (info.user_exists) return <ExistingUser info={info} token={token} description={description} signOut={signOut} />;

	return (
		<AuthLayout
			title="You are invited"
			description={description}
		>
			<p className="rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm" aria-label="Invited email">
				{info.email}
			</p>
			<form onSubmit={submit} className="space-y-4">
				<Field id="name" label="Your name">
					<Input id="name" required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
				</Field>
				<Field id="password" label="Password" hint="At least 8 characters.">
					<Input id="password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="password-hint" />
				</Field>
				<Field id="confirm" label="Confirm password">
					<Input id="confirm" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				</Field>
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					Accept invite
				</Button>
			</form>
		</AuthLayout>
	);
}

/** The invited email already has a login: sign in as it (if not already) and accept with one click. */
function ExistingUser({ info, token, description, signOut }: { info: InviteInfo; token: string; description: ReactNode; signOut: () => Promise<void> }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [error, setError] = useState('');
	const accept = useMutation({
		mutationFn: () => api<{ workspace_id: string }>(`/api/invites/${token}`, { method: 'POST', body: {} }),
		onSuccess: async (res) => {
			await qc.invalidateQueries({ queryKey: ['workspaces'] });
			workspaceStore.remember(res.workspace_id);
			window.location.hash = hashFor(res.workspace_id);
			navigate(hashFor(res.workspace_id).slice(1), { replace: true });
		},
		onError: (e) => setError(errorMessage(e)),
	});
	const signedInAs = info.signed_in_as?.toLowerCase() ?? null;
	const mine = signedInAs === info.email.toLowerCase();

	return (
		<AuthLayout title="You are invited" description={description}>
			<p className="rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm" aria-label="Invited email">
				{info.email}
			</p>
			{mine ? (
				<>
					<p className="text-sm text-ink-2">You are signed in as this address. Accepting adds the workspace to the ones you already have.</p>
					{error ? <FieldError>{error}</FieldError> : null}
					<Button className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
						Accept invite
					</Button>
				</>
			) : signedInAs ? (
				<>
					<Alert variant="warning" title="Wrong account">
						This invite is for {info.email}, but you are signed in as {info.signed_in_as}. Sign out and sign in as {info.email} to accept it.
					</Alert>
					<Button variant="secondary" className="w-full" onClick={() => void signOut()}>
						Sign out
					</Button>
				</>
			) : (
				<>
					<p className="text-sm text-ink-2">{info.email} already has an Inbox Angel login. Sign in with it to accept; this adds the workspace to your account.</p>
					<InlineSignIn email={info.email} token={token} />
				</>
			)}
		</AuthLayout>
	);
}

/** Sign in as the invited address without leaving the invite: afterwards the page offers the one-click accept. */
function InlineSignIn({ email, token }: { email: string; token: string }) {
	const { signedIn } = useSession();
	const qc = useQueryClient();
	const [password, setPassword] = useState('');
	const [error, setError] = useState('');
	const login = useMutation({
		mutationFn: () => api('/api/auth/login', { method: 'POST', body: { email, password } }),
		onSuccess: async () => {
			await signedIn();
			await qc.invalidateQueries({ queryKey: ['invite', token] });
		},
		onError: (e) => setError(errorMessage(e)),
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				setError('');
				login.mutate();
			}}
			className="space-y-4"
		>
			<Field id="invite-password" label="Password">
				<Input id="invite-password" type="password" required autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
			</Field>
			{error ? <FieldError>{error}</FieldError> : null}
			<Button type="submit" className="w-full" loading={login.isPending}>
				Sign in to accept
			</Button>
		</form>
	);
}
