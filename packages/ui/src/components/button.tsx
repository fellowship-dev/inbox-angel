import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				// Brand FILL with navy text (white on #60a5fa fails AA).
				primary: "bg-brand text-brand-fg hover:bg-brand-hover",
				secondary: "border border-line-strong bg-surface-1 text-ink-1 hover:bg-surface-2",
				ghost: "text-ink-1 hover:bg-surface-2",
				danger: "border border-danger bg-danger-subtle text-danger hover:bg-surface-2",
				link: "rounded-sm text-brand-ink underline underline-offset-4 hover:text-ink-1",
			},
			size: {
				sm: "h-8 px-3 text-sm [&_svg]:size-4",
				md: "h-10 px-4 text-sm [&_svg]:size-4",
				lg: "h-12 px-6 text-base [&_svg]:size-5",
			},
		},
		defaultVariants: { variant: "primary", size: "md" },
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	/** Render the child element (e.g. a router link) with button styles. */
	asChild?: boolean;
	/** Shows a spinner, sets aria-busy and blocks clicks. */
	loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
		const classes = cn(buttonVariants({ variant, size }), className);
		if (asChild) {
			return (
				<Slot ref={ref} className={classes} {...props}>
					{children}
				</Slot>
			);
		}
		return (
			<button
				ref={ref}
				type="button"
				className={classes}
				disabled={disabled}
				aria-disabled={loading || undefined}
				aria-busy={loading || undefined}
				{...props}
				onClick={loading ? undefined : props.onClick}
			>
				{loading ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
				{children}
			</button>
		);
	},
);
Button.displayName = "Button";
