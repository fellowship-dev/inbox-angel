"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
	React.ComponentRef<typeof TabsPrimitive.List>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.List ref={ref} className={cn("inline-flex items-center gap-1 border-b border-line", className)} {...props} />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
	React.ComponentRef<typeof TabsPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.Trigger
		ref={ref}
		className={cn(
			"-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:text-ink-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-brand-ink data-[state=active]:text-ink-1",
			className,
		)}
		{...props}
	/>
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
	React.ComponentRef<typeof TabsPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => <TabsPrimitive.Content ref={ref} className={cn("mt-4", className)} {...props} />);
TabsContent.displayName = "TabsContent";
