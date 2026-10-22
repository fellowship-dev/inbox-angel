import * as React from "react";
import { cn } from "../lib/cn.js";

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Breadcrumb or back link, above the title. */
	eyebrow?: React.ReactNode;
	/** Actions, right-aligned from `sm` up. One primary at most. */
	actions?: React.ReactNode;
}

export const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(
	({ className, title, description, eyebrow, actions, ...props }, ref) => (
		<header ref={ref} className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)} {...props}>
			<div className="min-w-0 space-y-1.5">
				{eyebrow ? <div className="text-sm text-ink-2">{eyebrow}</div> : null}
				<h1 className="break-words text-2xl font-bold tracking-tight text-ink-1 sm:text-3xl">{title}</h1>
				{description ? <p className="max-w-prose text-base text-ink-2">{description}</p> : null}
			</div>
			{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
		</header>
	),
);
PageHeader.displayName = "PageHeader";
