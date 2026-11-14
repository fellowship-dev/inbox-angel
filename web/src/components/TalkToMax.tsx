import { cn } from '@ready-set-mail/ui';
import { ExternalLink, MessageCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useHelpUrl } from '../lib/session';

/** Said by every "Talk to Max" link to assistive tech and on hover: who, what for, and that it leaves the page. */
export const TALK_TO_MAX_TITLE = 'Book a call with Max, who runs Ready Set Mail, about your email setup. Opens in a new tab.';

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
			Talk to Max
		</a>
	);
}

/**
 * How specific a stuck moment is. One screen shows the top-bar link plus at most ONE contextual line: the most
 * specific one present (ties: the first on the page).
 */
export const HELP_PRIORITY = {
	planLimit: 90,
	domainRefused: 80,
	claimStuck: 70,
	dnsFailing: 50,
	loadError: 40,
	tightening: 30,
	reportsNotConnected: 10,
	page: 10,
} as const;

interface SlotApi {
	register: (id: string, priority: number) => void;
	unregister: (id: string) => void;
}
const SlotApiContext = createContext<SlotApi | null>(null);
const SlotWinnerContext = createContext<string | null>(null);

/** One screen's contextual "Talk to Max" slot. Without a scope (isolated components, tests) every line renders. */
export function TalkToMaxScope({ children }: { children: ReactNode }) {
	const [entries, setEntries] = useState<ReadonlyMap<string, { priority: number; order: number }>>(new Map());
	const order = useRef(0);
	const register = useCallback((id: string, priority: number) => {
		setEntries((m) => {
			const had = m.get(id);
			if (had?.priority === priority) return m;
			const next = new Map(m);
			next.set(id, { priority, order: had?.order ?? order.current++ });
			return next;
		});
	}, []);
	const unregister = useCallback((id: string) => {
		setEntries((m) => {
			if (!m.has(id)) return m;
			const next = new Map(m);
			next.delete(id);
			return next;
		});
	}, []);
	const api = useMemo(() => ({ register, unregister }), [register, unregister]);
	let winner: string | null = null;
	let best: { priority: number; order: number } | null = null;
	for (const [id, e] of entries) {
		if (!best || e.priority > best.priority || (e.priority === best.priority && e.order < best.order)) {
			winner = id;
			best = e;
		}
	}
	return (
		<SlotApiContext.Provider value={api}>
			<SlotWinnerContext.Provider value={winner}>{children}</SlotWinnerContext.Provider>
		</SlotApiContext.Provider>
	);
}

/**
 * One plain line at a stuck moment: `lead` says the situation, `about` what the call is for.
 * "Lookups keep failing? Talk to Max about this domain." Renders nothing without a booking link.
 */
export function TalkToMax({
	lead,
	about,
	className,
	priority = HELP_PRIORITY.page,
	href,
}: {
	lead?: ReactNode;
	about?: string;
	className?: string;
	priority?: number;
	/** A link the caller already holds (e.g. a plan-limit response's help_url), used only when it is https. Default: the session's. */
	href?: string | null;
}) {
	const sessionUrl = useHelpUrl();
	const url = href === undefined ? sessionUrl : href && href.startsWith('https://') ? href : null;
	const id = useId();
	const slot = useContext(SlotApiContext);
	const winner = useContext(SlotWinnerContext);
	useLayoutEffect(() => {
		if (!slot || !url) return;
		slot.register(id, priority);
		return () => slot.unregister(id);
	}, [slot, id, priority, url]);
	if (!url) return null;
	if (slot && winner !== id) return null;
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
			</a>
			{about ? <> {about}</> : null}.
		</p>
	);
}

/**
 * Why adding a domain was refused, when a person can help: another workspace already owns it (409), or the
 * pending-claims cap was reached (429). Anything else (bad input, a rate limit,
 * a server error) gets no line: retrying or fixing the input is the answer. Only for domain-adding requests, where
 * 409 means "taken".
 */
export function domainRefusal(e: unknown): 'taken' | 'limit' | null {
	if (!(e instanceof ApiError)) return null;
	// A plan limit (code `plan_limit`) is PlanLimitNotice's, which carries its own single Talk to Max line.
	if ((e.body as { code?: string } | undefined)?.code === 'plan_limit') return null;
	if (e.status === 409) return 'taken';
	if (e.status === 429 && /unverified domains/i.test(e.message)) return 'limit';
	return null;
}

/** The "Talk to Max" line under a refused domain add, worded for why it was refused. Nothing for other errors. */
export function DomainRefusalHelp({ error, className }: { error: unknown; className?: string }) {
	const why = domainRefusal(error);
	if (why === 'taken') return <TalkToMax className={className} priority={HELP_PRIORITY.domainRefused} lead="Is this domain yours?" about="about getting access to it" />;
	if (why === 'limit') return <TalkToMax className={className} priority={HELP_PRIORITY.domainRefused} lead="Need more domains than this allows?" about="about your domains" />;
	return null;
}
