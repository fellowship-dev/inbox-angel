"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const itemBase =
	"relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-sm focus-visible:-outline-offset-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0";

const contentBase = "ia-pop z-50 min-w-[10rem] overflow-hidden rounded-md border border-line-strong bg-surface-1 p-1 text-ink-1 shadow-pop";

export const DropdownMenuContent = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
	<DropdownMenuPrimitive.Portal>
		<DropdownMenuPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn(contentBase, className)} {...props} />
	</DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
	<DropdownMenuPrimitive.Item ref={ref} className={cn(itemBase, destructive && "text-danger", className)} {...props} />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
	<DropdownMenuPrimitive.CheckboxItem ref={ref} className={cn(itemBase, "pl-8", className)} {...props}>
		<span className="absolute left-2 flex size-4 items-center justify-center">
			<DropdownMenuPrimitive.ItemIndicator>
				<Check aria-hidden className="text-brand-ink" />
			</DropdownMenuPrimitive.ItemIndicator>
		</span>
		{children}
	</DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuSubTrigger = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
	<DropdownMenuPrimitive.SubTrigger ref={ref} className={cn(itemBase, "data-[state=open]:bg-surface-2", className)} {...props}>
		{children}
		<ChevronRight aria-hidden className="ml-auto" />
	</DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
	<DropdownMenuPrimitive.SubContent ref={ref} className={cn(contentBase, className)} {...props} />
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export const DropdownMenuLabel = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
	<DropdownMenuPrimitive.Label ref={ref} className={cn("px-2 py-1.5 text-xs font-medium text-ink-2", className)} {...props} />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = React.forwardRef<
	React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";
