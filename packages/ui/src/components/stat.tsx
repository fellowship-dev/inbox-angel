import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";
import { Badge } from "./badge";

export interface StatDelta {
	/** Display text, e.g. "+4%" or "2 fewer". */
	value: string;
	direction: "up" | "down" | "flat";
	/** Whether this direction is good news. Drives tone; the arrow and sr text carry direction regardless. */
	good?: boolean;
}

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
	label: React.ReactNode;
	value: React.ReactNode;
	delta?: StatDelta;
	/** Comparison window for the delta: "vs. last 7 days". */
	deltaLabel?: string;
	/** Mark placeholder numbers (gallery, docs). Never ship fake numbers without it. */
	sample?: boolean;
}

const dirText = { up: "Up", down: "Down", flat: "No change" } as const;

export const Stat = React.forwardRef<HTMLDivElement, StatProps>(
	({ className, label, value, delta, deltaLabel, sample, ...props }, ref) => {
		const Arrow = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;
		return (
			<div ref={ref} className={cn("space-y-1", className)} {...props}>
				<dt className="flex items-center gap-2 text-sm text-ink-2">
					{label}
					{sample ? <Badge variant="outline">Sample</Badge> : null}
				</dt>
				<dd className="text-3xl font-bold tracking-tight text-ink-1 tabular-nums">{value}</dd>
				{delta ? (
					<dd
						className={cn(
							"flex items-center gap-1 text-sm font-medium",
							delta.good === undefined ? "text-ink-2" : delta.good ? "text-success" : "text-danger",
						)}
					>
						<Arrow aria-hidden className="size-4" />
						<span className="sr-only">{dirText[delta.direction]}: </span>
						{delta.value}
						{deltaLabel ? <span className="font-normal text-ink-2"> {deltaLabel}</span> : null}
					</dd>
				) : null}
			</div>
		);
	},
);
Stat.displayName = "Stat";

/** Lay stats out in a grid; renders the <dl> that Stat expects. */
export const StatGroup = React.forwardRef<HTMLDListElement, React.HTMLAttributes<HTMLDListElement>>(({ className, ...props }, ref) => (
	<dl ref={ref} className={cn("grid grid-cols-1 gap-6 sm:grid-cols-3", className)} {...props} />
));
StatGroup.displayName = "StatGroup";
