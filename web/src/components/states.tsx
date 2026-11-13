import { Alert, Button, Skeleton, cn } from '@inbox-angel/ui';
import { ChevronDown, Lock } from 'lucide-react';
import type { ButtonProps } from '@inbox-angel/ui';
import { createContext, forwardRef, useContext, useId, useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../lib/api';
import { READ_ONLY_REASON, useSession } from '../lib/session';

/** A failed request. 403 reads as "not allowed", everything else offers a retry. */
export function LoadError({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
	const forbidden = error instanceof ApiError && error.status === 403;
	return (
		<Alert variant="danger" title={forbidden ? 'You do not have access to this' : title}>
			<p>{errorMessage(error)}</p>
			{onRetry && !forbidden ? (
				<Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
					Try again
				</Button>
			) : null}
		</Alert>
	);
}

/** Skeleton rows for a loading region. The wrapper carries aria-busy; the bars are decorative. */
export function ListSkeleton({ rows = 3, className, label = 'Loading' }: { rows?: number; className?: string; label?: string }) {
	return (
		<div aria-busy="true" aria-label={label} role="status" className={cn('space-y-3', className)}>
			{Array.from({ length: rows }, (_, i) => (
				<Skeleton key={i} className="h-24 w-full" />
			))}
			<span className="sr-only">{label}…</span>
		</div>
	);
}

export function PageSkeleton({ label = 'Loading' }: { label?: string }) {
	return (
		<div aria-busy="true" role="status" className="space-y-6">
			<div className="space-y-2">
				<Skeleton className="h-8 w-1/3" />
				<Skeleton className="h-4 w-2/3" />
			</div>
			<Skeleton className="h-40 w-full" />
			<Skeleton className="h-40 w-full" />
			<span className="sr-only">{label}…</span>
		</div>
	);
}

/** Shown once per page that has write actions, when the caller is a member. */
export function ReadOnlyNotice({ className }: { className?: string }) {
	const { canWrite } = useSession();
	if (canWrite) return null;
	return (
		<Alert variant="info" title="Read-only access" className={className} data-testid="read-only-notice">
			{READ_ONLY_REASON}
		</Alert>
	);
}

/**
 * A button for an action that changes things. For members it is disabled and says why, in text
 * (a disabled control cannot take a tooltip on touch devices, and cannot be hovered at all).
 */
export const WriteButton = forwardRef<HTMLButtonElement, ButtonProps & { reasonVisible?: boolean }>(
	({ disabled, children, reasonVisible = false, ...props }, ref) => {
		const { canWrite } = useSession();
		const reasonId = useId();
		const blocked = !canWrite;
		return (
			<>
				<Button
					ref={ref}
					{...props}
					disabled={disabled || blocked}
					aria-describedby={blocked ? reasonId : props['aria-describedby']}
					title={blocked ? READ_ONLY_REASON : props.title}
				>
					{blocked ? <Lock aria-hidden /> : null}
					{children}
				</Button>
				<span id={reasonId} className={reasonVisible && blocked ? 'text-sm text-ink-2' : 'sr-only'}>
					{blocked ? READ_ONLY_REASON : null}
				</span>
			</>
		);
	},
);
WriteButton.displayName = 'WriteButton';

/**
 * `level`: the heading that names the current content (a Section's own h2, or the h2 of a Disclosure around it).
 * `titled`: a Disclosure already names it, so a Section inside renders no second heading. Headings below use
 * useHeadingTag(1), (2)… so a page reads h1 → h2 → h3 → h4 with no skipped level, collapsed or not.
 */
const SectionContext = createContext<{ level: 2; titled: boolean }>({ level: 2, titled: false });

/** The heading tag for something `offset` levels below the current Section (0 = the Section heading itself). */
export function useHeadingTag(offset = 0): 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
	const { level } = useContext(SectionContext);
	return `h${Math.min(6, level + offset)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}

export function Section({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
	const id = useId();
	const { titled } = useContext(SectionContext);
	// Inside a Disclosure the Disclosure's heading names this content: repeating it would read the title twice.
	if (titled) {
		return (
			<div className="space-y-3">
				{description || actions ? (
					<div className="flex flex-wrap items-end justify-between gap-2">
						{description ? <p className="text-sm text-ink-2">{description}</p> : <span />}
						{actions}
					</div>
				) : null}
				{children}
			</div>
		);
	}
	return (
		<section aria-labelledby={id} className="space-y-3">
			<div className="flex flex-wrap items-end justify-between gap-2">
				<div className="space-y-0.5">
					<h2 id={id} className="text-lg font-semibold tracking-tight">
						{title}
					</h2>
					{description ? <p className="text-sm text-ink-2">{description}</p> : null}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

/**
 * A collapsed section: an h2 whose button says what is inside ("DNS records: DMARC, SPF and 12 DKIM keys") and shows it
 * on demand (WAI-ARIA accordion pattern). The content stays mounted while closed, so its data is loaded once.
 */
export function Disclosure({ title, summary, children, defaultOpen = false, id }: { title: ReactNode; summary?: ReactNode; children: ReactNode; defaultOpen?: boolean; id?: string }) {
	const [open, setOpen] = useState(defaultOpen);
	const bodyId = useId();
	return (
		<section id={id} className="rounded-lg border border-line bg-surface-1">
			<h2 className="text-base">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={() => setOpen((o) => !o)}
					className="flex w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-surface-2 sm:px-5"
				>
					<span className="min-w-0 space-y-0.5">
						<span className="block font-semibold tracking-tight text-ink-1">{title}</span>
						{summary ? (
							<>
								<span className="sr-only">: </span>
								<span className="block text-sm font-normal text-ink-2">{summary}</span>
							</>
						) : null}
					</span>
					<ChevronDown aria-hidden className={cn('mt-0.5 size-5 shrink-0 text-ink-2 transition-transform', open && 'rotate-180')} />
				</button>
			</h2>
			<div id={bodyId} hidden={!open} className="min-w-0 border-t border-line px-4 py-4 sm:px-5">
				<SectionContext.Provider value={{ level: 2, titled: true }}>{children}</SectionContext.Provider>
			</div>
		</section>
	);
}
