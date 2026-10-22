import * as React from "react";
import { cn } from "../lib/cn";

/** Loading placeholder. Decorative (aria-hidden): mark the loading region with aria-busy="true". */
export const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
	<div ref={ref} aria-hidden className={cn("ia-shimmer rounded-md", className)} {...props} />
));
Skeleton.displayName = "Skeleton";
