import * as React from "react";
import { cn } from "../lib/cn.js";

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	icon?: React.ReactNode;
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Primary next step (a Button). One action, not a menu. */
	action?: React.ReactNode;
}

/** Say what is empty and what to do next; never a bare "No data". */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
	({ className, icon, title, description, action, ...props }, ref) => (
		<div
			ref={ref}
			className={cn("flex flex-col items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface-1 px-6 py-10 text-center", className)}
			{...props}
		>
			{icon ? (
				<div aria-hidden className="flex size-11 items-center justify-center rounded-full bg-brand-subtle text-brand-ink [&_svg]:size-5">
					{icon}
				</div>
			) : null}
			<div className="space-y-1">
				<p className="text-base font-semibold text-ink-1">{title}</p>
				{description ? <p className="mx-auto max-w-prose text-sm text-ink-2">{description}</p> : null}
			</div>
			{action ? <div className="pt-1">{action}</div> : null}
		</div>
	),
);
EmptyState.displayName = "EmptyState";
