import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/cn";

const dot = cva("inline-block size-2.5 shrink-0 rounded-full", {
	variants: {
		status: {
			ok: "bg-success",
			warn: "bg-warning",
			fail: "bg-danger",
			unknown: "border-2 border-ink-3 bg-transparent",
			info: "bg-brand-ink",
		},
	},
	defaultVariants: { status: "unknown" },
});

export type StatusDotStatus = NonNullable<VariantProps<typeof dot>["status"]>;

export interface StatusDotProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
	status: StatusDotStatus;
	/** Always required: the dot alone is colour-only. Shown unless `hideLabel`, then screen-reader only. */
	label: string;
	hideLabel?: boolean;
}

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
	({ className, status, label, hideLabel = false, ...props }, ref) => (
		<span ref={ref} className={cn("inline-flex items-center gap-2 text-sm text-ink-1", className)} {...props}>
			<span aria-hidden className={dot({ status })} />
			<span className={hideLabel ? "sr-only" : undefined}>{label}</span>
		</span>
	),
);
StatusDot.displayName = "StatusDot";
