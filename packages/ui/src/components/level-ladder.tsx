import { CheckCircle2 } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";

export type Level = 0 | 1 | 2;

export const LEVELS = [
	{ level: 0, name: "Delivering" },
	{ level: 1, name: "Authenticated" },
	{ level: 2, name: "Protected" },
] as const;

export interface LevelLadderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
	/** `null`: not known yet (not checked, or the check failed). Nothing is filled and the ladder says so. */
	level: Level | null;
	/** Accessible name of the meter. */
	label?: string;
}

/**
 * The signature element: Delivering → Authenticated → Protected as three rungs. Reached rungs are filled and get a
 * check; the current rung's name sits on the halo-gold accent (navy label, both themes), so the level reads from the
 * word and the check, never from colour alone. Unknown is its own state: empty rungs and "Level not known yet".
 */
export const LevelLadder = React.forwardRef<HTMLDivElement, LevelLadderProps>(({ level, label = "Protection level", className, ...props }, ref) => {
	const current = level === null ? null : LEVELS[level];
	return (
		<div
			ref={ref}
			role="progressbar"
			aria-label={label}
			aria-valuemin={1}
			aria-valuemax={3}
			aria-valuenow={level === null ? undefined : level + 1}
			aria-valuetext={current ? `Level ${current.level} of 2: ${current.name}` : "Level not known yet"}
			data-level={level ?? "unknown"}
			className={cn("grid grid-cols-3 gap-1.5", className)}
			{...props}
		>
			{LEVELS.map((l) => {
				const reached = level !== null && l.level <= level;
				const isCurrent = level === l.level;
				return (
					<div key={l.level} className="min-w-0 space-y-1.5">
						<div className={cn("h-2 rounded-full", reached ? "bg-brand-ink" : level === null ? "border border-dashed border-ink-3" : "bg-surface-3")} />
						<p
							className={cn(
								"flex w-fit max-w-full items-center gap-1 rounded-full text-xs leading-5",
								isCurrent ? "bg-accent px-1.5 font-semibold text-accent-fg" : reached ? "text-ink-1" : "text-ink-2",
							)}
						>
							{reached && !isCurrent ? <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-brand-ink" /> : null}
							<span className="truncate">{l.name}</span>
						</p>
					</div>
				);
			})}
			{level === null ? <p className="col-span-3 text-xs text-ink-2">Level not known yet</p> : null}
		</div>
	);
});
LevelLadder.displayName = "LevelLadder";
