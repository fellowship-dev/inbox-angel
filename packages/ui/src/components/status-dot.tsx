import { AlertTriangle, CheckCircle2, CircleDashed, Info, XCircle, type LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";

export type StatusDotStatus = "ok" | "warn" | "fail" | "unknown" | "info";

// Each status has its own shape, so the marker still reads when the label is visually hidden and colour is lost.
const meta: Record<StatusDotStatus, { Icon: LucideIcon; tone: string }> = {
	ok: { Icon: CheckCircle2, tone: "text-success" },
	warn: { Icon: AlertTriangle, tone: "text-warning" },
	fail: { Icon: XCircle, tone: "text-danger" },
	unknown: { Icon: CircleDashed, tone: "text-ink-3" },
	info: { Icon: Info, tone: "text-brand-ink" },
};

export interface StatusDotProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
	status: StatusDotStatus;
	/** Always required for assistive tech. Shown unless `hideLabel`, then screen-reader only. */
	label: string;
	hideLabel?: boolean;
}

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
	({ className, status, label, hideLabel = false, ...props }, ref) => {
		const { Icon, tone } = meta[status];
		return (
			<span ref={ref} data-status={status} className={cn("inline-flex items-center gap-2 text-sm text-ink-1", className)} {...props}>
				<Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
				<span className={hideLabel ? "sr-only" : undefined}>{label}</span>
			</span>
		);
	},
);
StatusDot.displayName = "StatusDot";
