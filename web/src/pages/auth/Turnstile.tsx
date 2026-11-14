import { Button } from '@ready-set-mail/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Cloudflare Turnstile, rendered explicitly. Automatic rendering only draws the widgets present when the script first loads,
 * so a form reached by navigating inside the app afterwards (sign-up → "Check your email") never got one. Here the script is
 * loaded once with `render=explicit`, and every form renders, resets and removes its own widget.
 */
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
	render(el: HTMLElement, opts: { sitekey: string; theme?: string; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }): string;
	reset(id: string): void;
	remove(id: string): void;
}
declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let loading: Promise<TurnstileApi> | null = null;

/** Tests only: forget a pending load. */
export function __resetTurnstileLoaderForTests(): void {
	loading = null;
}

/** Load the script once (shared by every widget); a failed load can be retried. */
export function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (loading) return loading;
	loading = new Promise<TurnstileApi>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = SRC;
		s.async = true;
		s.dataset.cfTurnstile = '1';
		s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start')));
		s.onerror = () => reject(new Error('Turnstile could not be loaded'));
		document.head.appendChild(s);
	}).catch((e: unknown) => {
		loading = null; // the next attempt loads it again
		document.querySelectorAll('script[data-cf-turnstile]').forEach((el) => el.remove());
		throw e;
	});
	return loading;
}

export type HumanCheck = {
	/** The form element to place inside the form (null when this instance has no bot check). */
	widget: ReactNode;
	/** The solved, unused token, if any. */
	token: string | null;
	/** True when the form may be submitted: no check configured, or a token is ready. */
	ready: boolean;
	/** Call after each submit: a token is single use, so a fresh check starts. */
	reset: () => void;
};

/**
 * One human check for one form. `siteKey` null: the instance has none, and the form needs nothing. The widget is its own
 * component, so it is rendered when the form mounts (also after in-app navigation back to it) and removed when it unmounts.
 */
export function useHumanCheck(siteKey: string | null | undefined): HumanCheck {
	const [token, setToken] = useState<string | null>(null);
	const resetWidget = useRef<(() => void) | null>(null);
	const reset = useCallback(() => {
		setToken(null);
		resetWidget.current?.();
	}, []);
	if (!siteKey) return { widget: null, token: null, ready: true, reset };
	return { widget: <HumanCheckBox siteKey={siteKey} onToken={setToken} resetRef={resetWidget} hasToken={!!token} />, token, ready: !!token, reset };
}

function HumanCheckBox({ siteKey, onToken, resetRef, hasToken }: { siteKey: string; onToken: (t: string | null) => void; resetRef: { current: (() => void) | null }; hasToken: boolean }) {
	const box = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'rejected'>('loading');
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let gone = false;
		let id: string | null = null;
		setState('loading');
		loadTurnstile().then(
			(api) => {
				if (gone || !box.current) return;
				id = api.render(box.current, {
					sitekey: siteKey,
					theme: 'auto',
					callback: (t) => {
						setState('ready');
						onToken(t);
					},
					'expired-callback': () => {
						onToken(null);
						if (id) api.reset(id);
					},
					'error-callback': () => {
						onToken(null);
						setState('rejected');
					},
				});
				resetRef.current = () => id && api.reset(id);
				setState('ready');
			},
			() => {
				if (!gone) setState('failed');
			},
		);
		return () => {
			gone = true;
			if (id && window.turnstile) window.turnstile.remove(id);
			resetRef.current = null;
			onToken(null);
		};
	}, [siteKey, attempt, onToken, resetRef]);

	return (
		<div className="space-y-2">
			<div ref={box} data-testid="human-check" />
			{state === 'failed' ? (
				<p className="text-sm text-danger" role="alert">
					The human check could not be loaded. Check your connection, then{' '}
					<Button type="button" variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
						try again
					</Button>
					.
				</p>
			) : state === 'rejected' ? (
				<p className="text-sm text-danger" role="alert">
					The human check did not pass.{' '}
					<Button type="button" variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
						Try it again
					</Button>
					{' '}or reload the page.
				</p>
			) : !hasToken ? (
				<p className="text-sm text-ink-2" aria-live="polite">
					Waiting for the human check…
				</p>
			) : null}
		</div>
	);
}
