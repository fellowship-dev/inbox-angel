import { Alert, Button, Skeleton, cn } from '@inbox-angel/ui';
import { Lock } from 'lucide-react';
import type { ButtonProps } from '@inbox-angel/ui';
import { forwardRef, useId, type ReactNode } from 'react';
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

export function Section({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
	const id = useId();
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
