import { Alert, Button, FieldError, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { TalkToMax } from '../../components/TalkToMax';
import { AuthLayout, Field } from './AuthLayout';
import { useHumanCheck } from './Turnstile';

/** How long the emailed link works (src/auth/welcome.ts VERIFICATION_LINK_HOURS). */
export const LINK_HOURS = 24;

type Problem = 'link_expired' | 'link_used' | 'link_invalid';

/**
 * Where the emailed link lands (`#/welcome/<token>`, the token in the fragment). Opening it changes nothing; saving the
 * password confirms the email, replaces any earlier password, ends other sessions and signs in, all in one request.
 */
export function WelcomePage() {
	const { token = '' } = useParams();
	const { signedIn } = useSession();
	const navigate = useNavigate();
	const [name, setName] = useState('');
	const [password, setPassword] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const [problem, setProblem] = useState<Problem | null>(token.length < 20 ? 'link_invalid' : null);
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		if (password.length < 8) return setError('Password must be at least 8 characters.');
		if (password !== confirm) return setError('Passwords do not match.');
		setBusy(true);
		try {
			await api('/api/auth/welcome', { method: 'POST', body: { token, password, ...(name.trim() ? { name: name.trim() } : {}) } });
			await signedIn();
			navigate('/', { replace: true });
		} catch (err) {
			const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
			if (code === 'link_expired' || code === 'link_used' || code === 'link_invalid') setProblem(code);
			else setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (problem === 'link_used') {
		return (
			<AuthLayout title="This link was already used">
				<Alert variant="info">A password was already chosen with this link. Sign in with it, or reset it if you don't remember it.</Alert>
				<Button asChild className="w-full">
					<Link to="/">Sign in</Link>
				</Button>
				<p className="text-center text-sm">
					<Link to="/forgot" className="text-brand-ink underline underline-offset-4">
						Forgot your password?
					</Link>
				</p>
			</AuthLayout>
		);
	}
	if (problem) return <NewLink expired={problem === 'link_expired'} />;

	return (
		<AuthLayout title="Choose your password" description="Saving it confirms your email and signs you in.">
			<form onSubmit={submit} className="space-y-4">
				<Field id="name" label="Your name (optional)" hint="Shown to people you invite to your workspace.">
					<Input id="name" autoFocus autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-describedby="name-hint" />
				</Field>
				<Field id="password" label="Password" hint="At least 8 characters.">
					<Input id="password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="password-hint" />
				</Field>
				<Field id="confirm" label="Confirm password">
					<Input id="confirm" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
				</Field>
				{error ? <FieldError>{error}</FieldError> : null}
				<Button type="submit" className="w-full" loading={busy}>
					Save password and continue
				</Button>
			</form>
		</AuthLayout>
	);
}

/** An expired or unusable link: ask for a new one (the answer is the same whether or not the address has an account). */
function NewLink({ expired }: { expired: boolean }) {
	const [email, setEmail] = useState('');
	const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
	const [error, setError] = useState('');
	const { status } = useSession();
	const check = useHumanCheck(status?.turnstile_site_key);

	async function send(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError('');
		setState('sending');
		const cf = check.token;
		try {
			await api('/api/auth/resend-verification', { method: 'POST', body: { email, ...(cf ? { cf_turnstile_token: cf } : {}) } });
			setState('sent');
		} catch (err) {
			setError(errorMessage(err));
			setState('idle');
		} finally {
			check.reset(); // a token is single use
		}
	}

	return (
		<AuthLayout title={expired ? 'This link has expired' : 'This link does not work'}>
			<p className="text-sm text-ink-2">
				{expired ? `Links work for ${LINK_HOURS} hours. ` : 'It may be incomplete: copy the whole link from the email, or '}
				{expired ? 'Enter your email and we will send you a new one.' : 'enter your email and we will send you a new one.'}
			</p>
			{state === 'sent' ? (
				<Alert variant="info">If that address has an account waiting to be confirmed, a new link is on its way. It can take a minute to arrive.</Alert>
			) : (
				<form onSubmit={send} className="space-y-4">
					<Field id="email" label="Email">
						<Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
					</Field>
					{check.widget}
					{error ? <FieldError>{error}</FieldError> : null}
					<Button type="submit" className="w-full" loading={state === 'sending'} disabled={!check.ready}>
						Send me a new link
					</Button>
				</form>
			)}
			<TalkToMax className="text-center" lead="Still stuck?" about="about signing in" />
		</AuthLayout>
	);
}
