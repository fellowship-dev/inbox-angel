import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";

const alertVariants = cva("relative flex gap-3 rounded-lg border p-4 text-sm", {
	variants: {
		variant: {
			info: "border-brand-ink/30 bg-brand-subtle text-ink-1 [&>svg]:text-brand-ink",
			success: "border-success/40 bg-success-subtle text-ink-1 [&>svg]:text-success",
			warning: "border-warning/40 bg-warning-subtle text-ink-1 [&>svg]:text-warning",
			danger: "border-danger/40 bg-danger-subtle text-ink-1 [&>svg]:text-danger",
		},
	},
	defaultVariants: { variant: "info" },
});

const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">, VariantProps<typeof alertVariants> {
	title?: React.ReactNode;
}

/** Icon + title keep meaning independent of colour. `danger` and `warning` use role="alert". */
export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
	({ className, variant = "info", title, children, role, ...props }, ref) => {
		const Icon = icons[variant ?? "info"];
		return (
			<div
				ref={ref}
				role={role ?? (variant === "danger" || variant === "warning" ? "alert" : "status")}
				className={cn(alertVariants({ variant }), className)}
				{...props}
			>
				<Icon aria-hidden className="mt-0.5 size-5 shrink-0" />
				<div className="min-w-0 flex-1 space-y-1">
					{title ? <p className="font-semibold leading-snug">{title}</p> : null}
					{children ? <div className="text-ink-2 [&_a]:text-brand-ink [&_a]:underline">{children}</div> : null}
				</div>
			</div>
		);
	},
);
Alert.displayName = "Alert";
