"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const TooltipProvider = ({ delayDuration = 200, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) => (
	<TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
);
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
	React.ComponentRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
	<TooltipPrimitive.Portal>
		<TooltipPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			className={cn("ia-pop z-50 max-w-xs rounded-md bg-ink-1 px-2.5 py-1.5 text-xs text-surface-1 shadow-lift", className)}
			{...props}
		/>
	</TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";
