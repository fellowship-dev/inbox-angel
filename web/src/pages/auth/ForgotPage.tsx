import { Alert, Button, FieldError, Input } from '@inbox-angel/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { AuthLayout, Field } from './AuthLayout';

export function ForgotPage() {
	const [email, setEmail] = useState('');
	const [sent, setSent] = useState(false);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		setBusy(true);
		try {
			await api('/api/auth/forgot', { method: 'POST', body: { email } });
			setSent(true);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (sent) {
		return (
			<AuthLayout title="Check your inbox">
				<Alert variant="success" title="Reset link on its way">
					If an account exists for <strong>{email}</strong>, we have sent a reset link. It expires in 1 hour.
				</Alert>
				<Link to="/login" className="text-sm text-brand-ink underline underline-offset-4">
					Back to sign in
				</Link>
			</AuthLayout>
		);
	}
	return (
		<AuthLayout title="Reset password" description="Enter your email and we will send you a reset link.">
			<form onSubmit={submit} className="space-y-4">
				<Field id="email" label="Email">
					<Input id="email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompany.com" />
				</Field>
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					Send reset link
				</Button>
			</form>
			<Link to="/login" className="text-sm text-brand-ink underline underline-offset-4">
				Back to sign in
			</Link>
		</AuthLayout>
	);
}
