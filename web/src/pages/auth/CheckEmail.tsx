import { Alert, Button } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../lib/api';
import { TalkToMax } from '../../components/TalkToMax';
import { AuthLayout } from './AuthLayout';
import { LINK_HOURS } from './WelcomePage';
import { useHumanCheck } from './Turnstile';
import { useSession } from '../../lib/session';

/** Shown when the server wants the email address verified before it opens a session (SaaS mode). */
export function CheckEmail({ email, onBack, note }: { email: string; onBack?: () => void; note?: string }) {
	const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
	const [error, setError] = useState('');
	const { status } = useSession();
	const check = useHumanCheck(status?.turnstile_site_key);

	// A resend passes the same bot check as sign-up: an address's allowance of mail is not free to spend.
	async function resend(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError('');
		setState('sending');
		const cf = check.token;
		try {
			await api('/api/auth/resend-verification', { method: 'POST', body: { email, ...(cf ? { cf_turnstile_token: cf } : {}) } });
			setState('sent');
		} catch (e) {
			setError(errorMessage(e));
			setState('idle');
		} finally {
			check.reset(); // a token is single use
		}
	}

	return (
		<AuthLayout title="Check your email" description={note ?? 'Open the link we sent. It confirms your email and opens a page where you choose your password.'}>
			<p className="rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm" aria-label="Verification email address">
				{email}
			</p>
			<p className="text-sm text-ink-2">The link works on any device until you save a password, for {LINK_HOURS} hours. Saving the password signs you in. If nothing arrives within a few minutes, check your spam folder or send it again.</p>
			{state === 'sent' ? <Alert variant="info">If this address is waiting to be confirmed, a new link is on its way. It can take a minute to arrive.</Alert> : null}
			{error ? <Alert variant="danger">{error}</Alert> : null}
			<form onSubmit={(e) => void resend(e)} className="space-y-4">
				{check.widget}
				<Button type="submit" variant="secondary" className="w-full" loading={state === 'sending'} disabled={!check.ready}>
					Resend verification email
				</Button>
			</form>
			<TalkToMax className="text-center" lead={state === 'sent' ? 'Still nothing after resending?' : 'No email, or a problem with the link?'} about="about signing in" />
			{onBack ? (
				<button type="button" className="block w-full text-center text-sm text-brand-ink underline underline-offset-4" onClick={onBack}>
					Back to sign in
				</button>
			) : null}
		</AuthLayout>
	);
}
