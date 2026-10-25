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
			className={cn("flex flex-col items-center gap-4 rounded-lg border border-dashed border-line-strong bg-surface-1 px-6 py-12 text-center sm:py-14", className)}
			{...props}
		>
			{icon ? (
				<div aria-hidden className="flex size-12 items-center justify-center rounded-full border border-line bg-brand-subtle text-brand-ink [&_svg]:size-5">
					{icon}
				</div>
			) : null}
			<div className="space-y-1">
				<p className="text-lg font-semibold tracking-tight text-ink-1">{title}</p>
				{description ? <p className="mx-auto max-w-md text-sm text-ink-2">{description}</p> : null}
			</div>
			{action ? <div className="pt-1">{action}</div> : null}
		</div>
	),
);
EmptyState.displayName = "EmptyState";
