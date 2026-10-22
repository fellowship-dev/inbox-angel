import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/cn";
import { buttonVariants } from "./button";

const iconSize = cva("p-0 [&_svg]:size-4", {
	variants: { size: { sm: "size-8", md: "size-10", lg: "size-12 [&_svg]:size-5" } },
	defaultVariants: { size: "md" },
});

export interface IconButtonProps
	extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">,
		VariantProps<typeof iconSize> {
	/** Accessible name. Required: an icon alone is not a label. */
	label: string;
	variant?: "primary" | "secondary" | "ghost" | "danger";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
	({ label, className, variant = "ghost", size, children, ...props }, ref) => (
		<button
			ref={ref}
			type="button"
			aria-label={label}
			className={cn(buttonVariants({ variant }), iconSize({ size }), className)}
			{...props}
		>
			{children}
		</button>
	),
);
IconButton.displayName = "IconButton";
