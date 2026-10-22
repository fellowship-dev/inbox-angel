import * as React from "react";
import { cn } from "../lib/cn";
import { EmptyState, type EmptyStateProps } from "./empty-state";

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
	/** When set, the scroll container becomes a labelled, keyboard-focusable region (needed for horizontal scroll). */
	label?: string;
	containerClassName?: string;
}

export const Table = React.forwardRef<HTMLTableElement, TableProps>(({ className, label, containerClassName, ...props }, ref) => (
	<div
		className={cn("relative w-full overflow-x-auto rounded-lg border border-line bg-surface-1", containerClassName)}
		{...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
	>
		<table ref={ref} className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
	</div>
));
Table.displayName = "Table";

export const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
	({ className, ...props }, ref) => <caption ref={ref} className={cn("border-t border-line p-3 text-left text-sm text-ink-2", className)} {...props} />,
);
TableCaption.displayName = "TableCaption";

export const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
	({ className, ...props }, ref) => <thead ref={ref} className={cn("bg-surface-2", className)} {...props} />,
);
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
	({ className, ...props }, ref) => <tbody ref={ref} className={cn("[&>tr:last-child]:border-0", className)} {...props} />,
);
TableBody.displayName = "TableBody";

export const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
	({ className, ...props }, ref) => (
		<tr ref={ref} className={cn("border-b border-line transition-colors hover:bg-surface-2/60 data-[state=selected]:bg-brand-subtle", className)} {...props} />
	),
);
TableRow.displayName = "TableRow";

export const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
	({ className, scope = "col", ...props }, ref) => (
		<th ref={ref} scope={scope} className={cn("h-10 px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide text-ink-2", className)} {...props} />
	),
);
TableHead.displayName = "TableHead";

export const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
	({ className, ...props }, ref) => <td ref={ref} className={cn("px-4 py-3 align-middle text-ink-1", className)} {...props} />,
);
TableCell.displayName = "TableCell";

/** A full-width row for "no data" — put it in TableBody when the list is empty. */
export function TableEmpty({ colSpan, ...emptyProps }: { colSpan: number } & EmptyStateProps) {
	return (
		<tr>
			<td colSpan={colSpan} className="p-0">
				<EmptyState {...emptyProps} className="border-0 bg-transparent" />
			</td>
		</tr>
	);
}
