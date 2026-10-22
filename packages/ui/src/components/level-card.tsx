import { AlertTriangle, CheckCircle2, CircleSlash, XCircle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";
import { Card, CardContent, CardHeader } from "./card";

export type Level = 0 | 1 | 2;

export const LEVELS = [
	{ level: 0, name: "Delivering" },
	{ level: 1, name: "Authenticated" },
	{ level: 2, name: "Protected" },
] as const;

export type FindingStatus = "pass" | "warn" | "fail" | "missing";

export interface Finding {
	status: FindingStatus;
	label: React.ReactNode;
	detail?: React.ReactNode;
}

const findingMeta = {
	pass: { Icon: CheckCircle2, tone: "text-success", word: "Pass" },
	warn: { Icon: AlertTriangle, tone: "text-warning", word: "Warning" },
	fail: { Icon: XCircle, tone: "text-danger", word: "Fail" },
	missing: { Icon: CircleSlash, tone: "text-danger", word: "Not found" },
} as const;

export interface LevelCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	level: Level;
	/** Domain the level belongs to; shown above the level name. */
	domain?: React.ReactNode;
	/** One sentence on what this level means for the user's email. */
	description?: React.ReactNode;
	findings?: Finding[];
	/** Footer: next step, button. */
	children?: React.ReactNode;
}

/**
 * Level 0–2 (Delivering → Authenticated → Protected) with a 3-segment bar.
 * Reached segments are filled AND get a check + label; the current one is bold, so the bar is not colour-only.
 */
export const LevelCard = React.forwardRef<HTMLDivElement, LevelCardProps>(
	({ className, level, domain, description, findings, children, ...props }, ref) => {
		const current = LEVELS[level];
		const headingId = React.useId();
		return (
			<Card ref={ref} role="group" aria-labelledby={headingId} className={className} {...props}>
				<CardHeader className="gap-3">
					<div className="space-y-1">
						{domain ? <p className="break-all font-mono text-sm text-ink-2">{domain}</p> : null}
						<h2 id={headingId} className="text-xl font-bold tracking-tight">
							<span className="text-ink-2">Level {current.level}</span> · {current.name}
						</h2>
					</div>
					<div
						role="progressbar"
						aria-valuemin={1}
						aria-valuemax={3}
						aria-valuenow={level + 1}
						aria-valuetext={`Level ${level} of 2: ${current.name}`}
						aria-label="Protection level"
						className="grid grid-cols-3 gap-1.5"
					>
						{LEVELS.map((l) => (
							<div key={l.level} className="space-y-1.5">
								<div className={cn("h-2 rounded-full", l.level <= level ? "bg-brand-ink" : "bg-surface-3")} />
								<p className={cn("flex items-center gap-1 text-xs", l.level === level ? "font-semibold text-ink-1" : "text-ink-2")}>
									{l.level <= level ? <CheckCircle2 aria-hidden className="size-3.5 text-brand-ink" /> : <span aria-hidden className="size-3.5 rounded-full border border-ink-3" />}
									{l.name}
									{l.level === level ? <span className="sr-only"> (current)</span> : null}
								</p>
							</div>
						))}
					</div>
					{description ? <p className="text-sm text-ink-2">{description}</p> : null}
				</CardHeader>
				<CardContent className="space-y-4">
					{findings?.length ? (
						<ul className="space-y-2.5" aria-label="Findings">
							{findings.map((f, i) => {
								const { Icon, tone, word } = findingMeta[f.status];
								return (
									<li key={i} className="flex items-start gap-2.5 text-sm">
										<Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone)} />
										<span className="min-w-0">
											<span className="sr-only">{word}: </span>
											<span className="text-ink-1">{f.label}</span>
											{f.detail ? <span className="block text-ink-2">{f.detail}</span> : null}
										</span>
									</li>
								);
							})}
						</ul>
					) : null}
					{children}
				</CardContent>
			</Card>
		);
	},
);
LevelCard.displayName = "LevelCard";
