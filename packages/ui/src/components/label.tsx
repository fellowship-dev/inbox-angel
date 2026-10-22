"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const Label = React.forwardRef<
	React.ComponentRef<typeof LabelPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
	<LabelPrimitive.Root
		ref={ref}
		className={cn("text-sm font-medium leading-none text-ink-1 peer-disabled:opacity-50", className)}
		{...props}
	/>
));
Label.displayName = "Label";

/** Helper text under a control. Link it with aria-describedby. */
export const FieldHint = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
	({ className, ...props }, ref) => <p ref={ref} className={cn("text-sm text-ink-2", className)} {...props} />,
);
FieldHint.displayName = "FieldHint";

/** Error text under a control. Announced politely; pair with aria-invalid on the control. */
export const FieldError = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
	({ className, ...props }, ref) => (
		<p ref={ref} role="alert" className={cn("text-sm font-medium text-danger", className)} {...props} />
	),
);
FieldError.displayName = "FieldError";
