import { Alert, Button, FieldError, Input } from '@inbox-angel/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthLayout, Field } from './AuthLayout';

export function ResetPage() {
	const { token = '' } = useParams();
	const { signedIn } = useSession();
	const navigate = useNavigate();
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [expired, setExpired] = useState(token.length < 10);
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		if (password.length < 8) return setError('Password must be at least 8 characters.');
		if (password !== confirm) return setError('Passwords do not match.');
		setBusy(true);
		try {
			await api('/api/auth/reset', { method: 'POST', body: { token, password } });
			// The reset opens a session (cookie); if it did not, the refetch finds nobody and the sign-in screen shows.
			await signedIn();
			navigate('/', { replace: true });
		} catch (err) {
			if (err instanceof ApiError && err.status === 400) setExpired(true);
			else setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (expired) {
		return (
			<AuthLayout title="Link expired">
				<Alert variant="warning" title="This reset link is invalid or has expired">
					Request a new one from the sign-in page.
				</Alert>
				<Button asChild variant="secondary" className="w-full">
					<Link to="/forgot">Request a new link</Link>
				</Button>
			</AuthLayout>
		);
	}
	return (
		<AuthLayout title="Set a new password">
			<form onSubmit={submit} className="space-y-4">
				<Field id="password" label="New password" hint="At least 8 characters.">
					<Input id="password" type="password" required autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="password-hint" />
				</Field>
				<Field id="confirm" label="Confirm password">
					<Input id="confirm" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				</Field>
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					Set password and sign in
				</Button>
			</form>
		</AuthLayout>
	);
}
