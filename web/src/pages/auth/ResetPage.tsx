import { Alert, Button, FieldError, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthLayout, Field } from './AuthLayout';

/**
 * Sets the password from an emailed token, then signs in. `welcome`: the page a hosted verification link opens, where a new
 * account chooses its password for the first time (sign-up asks for none); otherwise a password reset.
 */
export function ResetPage({ welcome = false }: { welcome?: boolean } = {}) {
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
				<Alert variant="warning" title={welcome ? 'This link is invalid or has expired' : 'This reset link is invalid or has expired'}>
					{welcome ? 'Your email is confirmed. Ask for a new link and we will email you one to choose your password.' : 'Request a new one from the sign-in page.'}
				</Alert>
				<Button asChild variant="secondary" className="w-full">
					<Link to="/forgot">Request a new link</Link>
				</Button>
			</AuthLayout>
		);
	}
	return (
		<AuthLayout title={welcome ? 'Choose your password' : 'Set a new password'} description={welcome ? 'Your email is confirmed. Choose the password you will sign in with.' : undefined}>
			<form onSubmit={submit} className="space-y-4">
				<Field id="password" label={welcome ? 'Password' : 'New password'} hint="At least 8 characters.">
					<Input id="password" type="password" required autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="password-hint" />
				</Field>
				<Field id="confirm" label="Confirm password">
					<Input id="confirm" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				</Field>
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					{welcome ? 'Save password and continue' : 'Set password and sign in'}
				</Button>
			</form>
		</AuthLayout>
	);
}
