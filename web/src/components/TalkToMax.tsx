import { cn } from '@inbox-angel/ui';
import { ExternalLink, MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useHelpUrl } from '../lib/session';

/** Said by every "Talk to Max" link to assistive tech and on hover: who, what for, and that it leaves the page. */
export const TALK_TO_MAX_TITLE = 'Book a call with Max, who runs Inbox Angel, about your email setup. Opens in a new tab.';

/**
 * The always-visible entry, for the app's top bars. Renders nothing unless the hosted service has a booking link,
 * so it is never a dead or disabled control. 44px tall on phones, 40px with the other top-bar controls from `sm`.
 */
export function TalkToMaxLink({ className }: { className?: string }) {
	const url = useHelpUrl();
	if (!url) return null;
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			title={TALK_TO_MAX_TITLE}
			data-testid="talk-to-max"
			className={cn(
				'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-brand-ink underline-offset-4 hover:bg-surface-2 hover:underline sm:min-h-10 sm:px-3',
				className,
			)}
		>
			<MessageCircle aria-hidden className="size-4 shrink-0" />
			<span>Talk to Max</span>
			<span className="sr-only">: book a call about your email setup (opens in a new tab)</span>
		</a>
	);
}

/**
 * One plain line at a stuck moment: `lead` says the situation, `about` what the call is for.
 * "Lookups keep failing? Talk to Max about this domain." Renders nothing without a booking link.
 */
export function TalkToMax({ lead, about, className }: { lead?: ReactNode; about?: string; className?: string }) {
	const url = useHelpUrl();
	if (!url) return null;
	return (
		<p className={cn('text-sm text-ink-2', className)} data-testid="talk-to-max">
			{lead ? <>{lead} </> : null}
			<a
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				title={TALK_TO_MAX_TITLE}
				className="inline-flex min-h-11 items-center gap-1 rounded-sm align-middle font-medium text-brand-ink underline underline-offset-4 hover:text-ink-1 sm:min-h-0"
			>
				Talk to Max
				<ExternalLink aria-hidden className="size-3.5 shrink-0" />
				<span className="sr-only"> (opens in a new tab)</span>
			</a>
			{about ? <> {about}</> : null}.
		</p>
	);
}

/**
 * Why adding a domain was refused, when a person can help: another workspace already owns it (409), or a limit was
 * reached (the pending-claims cap, or a plan limit with `code: plan_limit`). Anything else (bad input, a rate limit,
 * a server error) gets no line: retrying or fixing the input is the answer. Only for domain-adding requests, where
 * 409 means "taken".
 */
export function domainRefusal(e: unknown): 'taken' | 'limit' | null {
	if (!(e instanceof ApiError)) return null;
	const code = (e.body as { code?: string } | undefined)?.code;
	if (e.status === 409) return 'taken';
	if (code === 'plan_limit' || (e.status === 429 && /unverified domains/i.test(e.message))) return 'limit';
	return null;
}

/** The "Talk to Max" line under a refused domain add, worded for why it was refused. Nothing for other errors. */
export function DomainRefusalHelp({ error, className }: { error: unknown; className?: string }) {
	const why = domainRefusal(error);
	if (why === 'taken') return <TalkToMax className={className} lead="Is this domain yours?" about="about getting access to it" />;
	if (why === 'limit') return <TalkToMax className={className} lead="Need more domains than this allows?" about="about your domains" />;
	return null;
}
