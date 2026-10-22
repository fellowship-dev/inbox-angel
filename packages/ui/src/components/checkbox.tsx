"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const Checkbox = React.forwardRef<
	React.ComponentRef<typeof CheckboxPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
	<CheckboxPrimitive.Root
		ref={ref}
		className={cn(
			"peer inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-control bg-surface-1 text-brand-fg transition-colors data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	>
		<CheckboxPrimitive.Indicator className="flex items-center justify-center">
			{props.checked === "indeterminate" ? <Minus aria-hidden className="size-3.5" /> : <Check aria-hidden className="size-3.5" strokeWidth={3} />}
		</CheckboxPrimitive.Indicator>
	</CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";
