import { Alert, Button, Checkbox, FieldError, Input, Label } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { bindSignupDomainToEmail, readSignupDomain } from '../../lib/signup-intent';
import { useSession } from '../../lib/session';
import { TalkToMax } from '../../components/TalkToMax';
import { CheckEmail } from './CheckEmail';
import { AuthLayout, Field } from './AuthLayout';
import { useHumanCheck } from './Turnstile';
import { HostedAlternative } from '../../components/HostedAlternative';

const PROVIDER_LABELS: Record<string, string> = { github: 'GitHub', google: 'Google' };

type Mode = 'setup' | 'signup' | 'signin';

/**
 * One screen for the three ways in:
 *  - first run on a self-hosted instance (no owner yet): create the owner account;
 *  - hosted mode: sign in, or create an account when sign-up is open;
 *  - otherwise: sign in (a self-hosted instance is closed after setup: new people come in by invite).
 */
export function AuthPage({ initialMode }: { initialMode?: 'signup' } = {}) {
	const { status, signedIn } = useSession();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(initialMode === 'signup');
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [bootstrapProof, setBootstrapProof] = useState('');
	const [telemetry, setTelemetry] = useState(status?.telemetry_default ?? false);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	/** Set when the server wants the address verified before it opens a session. */
	const [verifyFor, setVerifyFor] = useState<string | null>(null);
	const check = useHumanCheck(status?.turnstile_site_key);

	if (!status) return null;
	// Older servers said signin_available: false when hosted bot protection was missing. Current servers always let existing
	// users sign in (closed means no new accounts), so this only shows against an older server.
	if (status.signin_available === false) {
		return (
			<AuthLayout title="Ready Set Mail">
				<Alert variant="info">Sign-up and sign-in aren't open here.</Alert>
				<TalkToMax className="text-center" lead="Want to get started?" about="about your domains" />
			</AuthLayout>
		);
	}
	const hosted = status.mode === 'saas';
	// The installer-proof screen is self-host only: the hosted service never asks a registrant for one.
	const mode: Mode = !status.configured && !hosted ? 'setup' : creating && status.signup_open ? 'signup' : 'signin';
	const registering = mode !== 'signin';
	// Hosted sign-up asks for the email only: the password is chosen once, on the page the verification link opens.
	const asksPassword = mode !== 'signup';
	const providers = status.oauth_providers.filter((p) => p in PROVIDER_LABELS);

	async function submit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError('');
		if (mode === 'setup') {
			if (password.length < 8) return setError('Password must be at least 8 characters.');
			if (password !== confirm) return setError('Passwords do not match.');
		}
		if (mode === 'setup' && bootstrapProof.length < 32) return setError('Installer proof must be at least 32 characters.');
		setBusy(true);
		try {
			const turnstile = check.token ? { cf_turnstile_token: check.token } : {};
			const endpoint = mode === 'setup' ? '/api/auth/setup' : mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
			const body = mode === 'setup' ? { name, email, password, telemetry, ...turnstile } : mode === 'signup' ? { email, ...turnstile } : { email, password, ...turnstile };
			if (mode === 'signup') bindSignupDomainToEmail(email);
			const res = await api<{ verification_required?: boolean; has_domain?: boolean }>(endpoint, { method: 'POST', body, ...(mode === 'setup' ? { headers: { 'X-Ready-Set-Mail-Bootstrap': bootstrapProof } } : {}) });
			setBootstrapProof('');
			if (res.verification_required) {
				setVerifyFor(email);
				return;
			}
			await signedIn();
			// A new owner with no domain yet goes straight to the setup wizard.
			if (registering && res.has_domain === false) navigate('/setup', { replace: true });
			else navigate('/', { replace: true });
		} catch (err) {
			if (err instanceof ApiError && err.status === 403 && (err.body as { code?: string } | undefined)?.code === 'email_not_verified') setVerifyFor(email);
			else if (mode === 'setup' && err instanceof ApiError && err.status === 403 && /installer proof/i.test(err.message)) setError('That installer proof was not accepted. Paste the exact BOOTSTRAP_SECRET value set on the Worker. If none was set yet, the person who deployed it needs to set one first.');
			else setError(errorMessage(err));
		} finally {
			setBusy(false);
			check.reset(); // a token is single use
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

	// "Back to sign in" opens sign-in, whichever form led here.
	if (verifyFor) return <CheckEmail email={verifyFor} onBack={() => { setVerifyFor(null); setCreating(false); setError(''); }} />;

	const requestedDomain = mode === 'signup' ? readSignupDomain() : null;
	const title = mode === 'setup' ? 'Create your account' : mode === 'signup' ? 'Create an account' : 'Sign in';
	const description =
		mode === 'setup'
			? 'This creates the account that owns this instance. It needs the installer proof, a secret only the person who deployed it holds. There is no default password.'
			: mode === 'signup'
				? hosted
					? 'See where your domains stand and what to fix, checked from live DNS. DMARC reports are not connected yet.'
					: 'Start monitoring your domains.'
				: undefined;

	return (
		<AuthLayout title={title} description={description}>
			{mode === 'signup' && requestedDomain ? (
				<p className="text-sm text-ink-2">
					You're adding <span className="font-mono [overflow-wrap:anywhere]">{requestedDomain}</span>. You'll confirm it after you verify your email.
				</p>
			) : null}
			<form onSubmit={submit} className="space-y-4" noValidate={false}>
				{mode === 'setup' ? <Field id="bootstrap-proof" label="Installer proof" hint="The BOOTSTRAP_SECRET value set on the Worker before its first start. The setup guide keeps it in a private file, such as ~/.config/ready-set-mail/bootstrap-proof. It works once. Never paste it into an agent chat."><Input id="bootstrap-proof" type="password" required minLength={32} autoComplete="off" value={bootstrapProof} onChange={e => setBootstrapProof(e.target.value)} /></Field> : null}
				{/* Hosted sign-up asks for no name: one typed before the address is proven could be anyone's; the welcome page asks. */}
				{mode === 'setup' ? (
					<Field id="name" label="Your name (optional)">
						<Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Jane Smith" />
					</Field>
				) : null}
				<Field id="email" label="Email" hint={mode === 'signup' ? "We'll email you a link. It opens a page where you choose your password and are signed in." : registering ? (hosted ? 'Used to sign in.' : 'Used to sign in and to receive monitoring alerts.') : undefined}>
					<Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@yourcompany.com" aria-describedby={registering ? 'email-hint' : undefined} />
				</Field>
				{asksPassword ? (
					<Field id="password" label="Password" hint={registering ? 'At least 8 characters.' : undefined}>
						<Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={registering ? 'new-password' : 'current-password'} aria-describedby={registering ? 'password-hint' : undefined} />
					</Field>
				) : null}
				{mode === 'setup' ? (
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
				{check.widget}
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy} disabled={!check.ready}>
					{mode === 'signin' ? 'Sign in' : 'Create account'}
				</Button>
			</form>

			{mode === 'setup' ? <HostedAlternative url={status.hosted_service_url} /> : null}

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
					{hosted ? "New accounts can't be created here right now. If you already have one, sign in." : 'Sign-up is closed on this instance. Ask an owner for an invite link.'}
				</Alert>
			) : null}
			{hosted && status.configured && !status.signup_open ? <TalkToMax className="text-center" lead="Want an account?" about="about your domains" /> : null}
			{mode === 'signup' ? <TalkToMax className="text-center" lead="Questions first, or rather have someone set it up for you?" about="about your domains" /> : null}
		</AuthLayout>
	);
}
