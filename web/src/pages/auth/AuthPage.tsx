import { Alert, Button, Checkbox, FieldError, Input, Label } from '@inbox-angel/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AuthLayout, Field } from './AuthLayout';
import { Turnstile, turnstileToken } from './Turnstile';

const PROVIDER_LABELS: Record<string, string> = { github: 'GitHub', google: 'Google' };

type Mode = 'setup' | 'signup' | 'signin';

/**
 * One screen for the three ways in:
 *  - first run on a self-hosted instance (no owner yet): create the owner account;
 *  - hosted mode: sign in, or create an account when sign-up is open;
 *  - otherwise: sign in (a self-hosted instance is closed after setup: new people come in by invite).
 */
export function AuthPage() {
	const { status, signedIn } = useSession();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [telemetry, setTelemetry] = useState(status?.telemetry_default ?? false);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	if (!status) return null;
	const mode: Mode = !status.configured ? 'setup' : creating && status.signup_open ? 'signup' : 'signin';
	const registering = mode !== 'signin';
	const providers = status.oauth_providers.filter((p) => p in PROVIDER_LABELS);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError('');
		if (registering) {
			if (password.length < 8) return setError('Password must be at least 8 characters.');
			if (password !== confirm) return setError('Passwords do not match.');
		}
		setBusy(true);
		try {
			const cf = status?.turnstile_site_key ? turnstileToken(e.currentTarget) : undefined;
			const turnstile = cf ? { cf_turnstile_token: cf } : {};
			const endpoint = mode === 'setup' ? '/api/auth/setup' : mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
			const body = registering ? { name, email, password, ...(mode === 'setup' ? { telemetry } : {}), ...turnstile } : { email, password, ...turnstile };
			const res = await api<{ token: string | null; has_domain?: boolean }>(endpoint, { method: 'POST', body });
			await signedIn(res.token);
			// A new owner with no domain yet goes straight to the setup wizard.
			if (registering && res.has_domain === false) navigate('/setup', { replace: true });
			else navigate('/', { replace: true });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function oauth(provider: string) {
		setError('');
		try {
			const res = await api<{ url?: string }>('/api/auth/sign-in/social', { method: 'POST', body: { provider, callbackURL: '/' } });
			if (!res.url) return setError('Could not start sign-in.');
			window.location.href = res.url;
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	const title = mode === 'setup' ? 'Create your account' : mode === 'signup' ? 'Create an account' : 'Sign in';
	const description =
		mode === 'setup' ? 'Set up your Inbox Angel instance. You will use these credentials to sign in.' : mode === 'signup' ? 'Start monitoring your domains.' : undefined;

	return (
		<AuthLayout title={title} description={description}>
			<form onSubmit={submit} className="space-y-4" noValidate={false}>
				{registering ? (
					<Field id="name" label="Your name (optional)">
						<Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Jane Smith" />
					</Field>
				) : null}
				<Field id="email" label="Email" hint={registering ? 'Used to sign in and to receive monitoring alerts.' : undefined}>
					<Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@yourcompany.com" aria-describedby={registering ? 'email-hint' : undefined} />
				</Field>
				<Field id="password" label="Password" hint={registering ? 'At least 8 characters.' : undefined}>
					<Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={registering ? 'new-password' : 'current-password'} aria-describedby={registering ? 'password-hint' : undefined} />
				</Field>
				{registering ? (
					<Field id="confirm" label="Confirm password">
						<Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
					</Field>
				) : null}
				{mode === 'setup' ? (
					<div className="flex items-start gap-3">
						<Checkbox id="telemetry" checked={telemetry} onCheckedChange={(v) => setTelemetry(v === true)} className="mt-0.5" />
						<Label htmlFor="telemetry" className="font-normal leading-snug">
							<strong className="font-semibold">Share anonymous usage stats.</strong>{' '}
							<span className="text-ink-2">Feature usage counts only: no personal data, email addresses or domain names. You can change this later.</span>
						</Label>
					</div>
				) : null}
				{status.turnstile_site_key ? <Turnstile siteKey={status.turnstile_site_key} /> : null}
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					{mode === 'signin' ? 'Sign in' : 'Create account'}
				</Button>
			</form>

			{mode === 'signin' ? (
				<p className="text-center text-sm">
					<Link to="/forgot" className="text-brand-ink underline underline-offset-4">
						Forgot your password?
					</Link>
				</p>
			) : null}

			{mode !== 'setup' && providers.length > 0 ? (
				<div className="space-y-2 border-t border-line pt-4">
					<p className="text-center text-sm text-ink-2">or continue with</p>
					{providers.map((p) => (
						<Button key={p} variant="secondary" className="w-full" onClick={() => oauth(p)}>
							{PROVIDER_LABELS[p]}
						</Button>
					))}
				</div>
			) : null}

			{status.configured && status.signup_open ? (
				<p className="text-center text-sm text-ink-2">
					{creating ? 'Already have an account?' : 'New here?'}{' '}
					<button type="button" className="text-brand-ink underline underline-offset-4" onClick={() => { setCreating(!creating); setError(''); }}>
						{creating ? 'Sign in' : 'Create an account'}
					</button>
				</p>
			) : null}
			{status.configured && !status.signup_open ? (
				<Alert variant="info" className="text-left">
					Sign-up is closed on this instance. Ask an owner for an invite link.
				</Alert>
			) : null}
		</AuthLayout>
	);
}
