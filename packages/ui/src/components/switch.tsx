"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const Switch = React.forwardRef<
	React.ComponentRef<typeof SwitchPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
	<SwitchPrimitive.Root
		ref={ref}
		className={cn(
			"peer inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-control bg-surface-2 transition-colors data-[state=checked]:border-brand data-[state=checked]:bg-brand disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	>
		<SwitchPrimitive.Thumb className="pointer-events-none block size-4 translate-x-1 rounded-full bg-ink-2 shadow-soft transition-transform data-[state=checked]:translate-x-6 data-[state=checked]:bg-brand-fg" />
	</SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
