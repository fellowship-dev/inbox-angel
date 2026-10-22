"use client";

import { Slot } from "@radix-ui/react-slot";
import type { VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import { buttonVariants } from "./button-variants.js";

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
