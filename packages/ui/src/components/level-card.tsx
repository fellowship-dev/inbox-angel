import { AlertTriangle, CheckCircle2, CircleHelp, CircleSlash, XCircle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import { Card, CardContent, CardHeader } from "./card.js";
import { LEVELS, LevelLadder, type Level } from "./level-ladder.js";

export { LEVELS, type Level } from "./level-ladder.js";

/** `unknown`: nothing has been checked yet. Neutral, never shown as missing. */
export type FindingStatus = "pass" | "warn" | "fail" | "missing" | "unknown";

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
	unknown: { Icon: CircleHelp, tone: "text-ink-2", word: "Not checked yet" },
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
 * Level 0–2 (Delivering → Authenticated → Protected) on the LevelLadder, with findings below.
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
					<LevelLadder level={level} />
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
