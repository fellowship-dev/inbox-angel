import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const badgeVariants = cva(
	"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5 [&_svg]:size-3",
	{
		variants: {
			variant: {
				neutral: "border-line-strong bg-surface-2 text-ink-1",
				brand: "border-brand-ink/30 bg-brand-subtle text-brand-ink",
				success: "border-success/40 bg-success-subtle text-success",
				warning: "border-warning/40 bg-warning-subtle text-warning",
				danger: "border-danger/40 bg-danger-subtle text-danger",
				outline: "border-line-strong bg-transparent text-ink-2",
			},
		},
		defaultVariants: { variant: "neutral" },
	},
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/** Pair semantic variants with an icon or a word: colour is never the only signal. */
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
	<span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = "Badge";
