import * as React from "react";
import { cn } from "../lib/cn.js";

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	/** What is empty and why, as a plain statement: "No reports for example.com in the last 7 days". */
	title: React.ReactNode;
	/** The one thing to do next, and what will appear once it is done. */
	description?: React.ReactNode;
	/** That one next step (a Button or link). One action, not a menu. */
	action?: React.ReactNode;
}

/**
 * An empty region that teaches: why it is empty, then the one thing to do next. No icon-in-a-circle, no slogan:
 * a quiet left-aligned note in the flow of the page, with its action beside it.
 */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(({ className, title, description, action, ...props }, ref) => (
	<div
		ref={ref}
		data-slot="empty-state"
		className={cn("flex flex-col gap-3 rounded-lg border border-line bg-surface-1 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}
		{...props}
	>
		<div className="min-w-0 space-y-1">
			<p className="text-base font-semibold text-ink-1">{title}</p>
			{description ? <p className="max-w-prose text-sm text-ink-2">{description}</p> : null}
		</div>
		{action ? <div className="shrink-0">{action}</div> : null}
	</div>
));
EmptyState.displayName = "EmptyState";
