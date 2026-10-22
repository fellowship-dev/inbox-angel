import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";
import { controlClasses } from "./input";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
	<SelectPrimitive.Trigger
		ref={ref}
		className={cn(controlClasses, "flex h-10 items-center justify-between gap-2 text-left data-[placeholder]:text-ink-3 [&>span]:truncate", className)}
		{...props}
	>
		{children}
		<SelectPrimitive.Icon asChild>
			<ChevronDown aria-hidden className="size-4 shrink-0 text-ink-2" />
		</SelectPrimitive.Icon>
	</SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
	<SelectPrimitive.Portal>
		<SelectPrimitive.Content
			ref={ref}
			position={position}
			className={cn(
				"ia-pop relative z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-md border border-line-strong bg-surface-1 text-ink-1 shadow-pop",
				position === "popper" && "w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-ink-2">
				<ChevronUp aria-hidden className="size-4" />
			</SelectPrimitive.ScrollUpButton>
			<SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
			<SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-ink-2">
				<ChevronDown aria-hidden className="size-4" />
			</SelectPrimitive.ScrollDownButton>
		</SelectPrimitive.Content>
	</SelectPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";

export const SelectLabel = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Label ref={ref} className={cn("px-2 py-1.5 text-xs font-medium text-ink-2", className)} {...props} />
));
SelectLabel.displayName = "SelectLabel";

export const SelectItem = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
	<SelectPrimitive.Item
		ref={ref}
		className={cn(
			"relative flex cursor-default select-none items-center rounded-sm py-2 pl-8 pr-2 text-sm focus-visible:-outline-offset-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2",
			className,
		)}
		{...props}
	>
		<span className="absolute left-2 flex size-4 items-center justify-center">
			<SelectPrimitive.ItemIndicator>
				<Check aria-hidden className="size-4 text-brand-ink" />
			</SelectPrimitive.ItemIndicator>
		</span>
		<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
	</SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";

export const SelectSeparator = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />
));
SelectSeparator.displayName = "SelectSeparator";
