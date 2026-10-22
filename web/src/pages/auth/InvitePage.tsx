import { Alert, Badge, Button, FieldError, Input, Skeleton } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthLayout, Field } from './AuthLayout';

interface InviteInfo {
	email: string;
	invited_by: string;
	role: string;
}

export function InvitePage() {
	const { token = '' } = useParams();
	const { signedIn } = useSession();
	const navigate = useNavigate();
	const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api<InviteInfo>(`/api/invites/${token}`), retry: false });
	const [name, setName] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		if (password.length < 8) return setError('Password must be at least 8 characters.');
		if (password !== confirm) return setError('Passwords do not match.');
		setBusy(true);
		try {
			const res = await api<{ token: string | null }>(`/api/invites/${token}`, { method: 'POST', body: { name: name.trim(), password } });
			await signedIn(res.token);
			navigate('/', { replace: true });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

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
	return (
		<AuthLayout
			title="You are invited"
			description={
				<>
					<strong>{info.invited_by}</strong> invited you to join their Inbox Angel workspace as <Badge variant="brand">{info.role}</Badge>
				</>
			}
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
