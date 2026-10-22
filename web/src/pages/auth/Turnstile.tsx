import { useEffect, useRef } from 'react';

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** Cloudflare Turnstile, only when the instance has a site key. The token is read from the form at submit. */
export function Turnstile({ siteKey }: { siteKey: string }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!document.querySelector('script[data-cf-turnstile]')) {
			const s = document.createElement('script');
			s.src = SRC;
			s.async = true;
			s.dataset.cfTurnstile = '1';
			document.head.appendChild(s);
		}
	}, []);
	return <div ref={ref} className="cf-turnstile" data-sitekey={siteKey} data-theme="auto" />;
}

/** The solved-challenge token inside `form`, if the widget is present and solved. */
export function turnstileToken(form: HTMLFormElement): string | undefined {
	const input = form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
	return input?.value || undefined;
}
