import { AlertTriangle, CheckCircle2, CircleArrowRight, CircleHelp, Clock, FileText, Info, XCircle, type LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import type { BadgeProps } from "./badge.js";
import type { CheckStatus } from "./check-result.js";
import type { FindingStatus } from "./level-card.js";
import type { StatusDotStatus } from "./status-dot.js";

/**
 * The status vocabulary shared with the Ready Set Mail website (`frontend/components/site/Status.tsx` there): a state says
 * what it means and who acts next, always as an icon plus a word, never colour alone. Same keys, labels and order as the
 * website, so a domain reads the same before and after sign-up.
 *
 * The first five describe a check (what public DNS or the reports show). The last three are work states:
 * a record written but not yet visible in DNS, a tightening step waiting for a person, and reports still coming in.
 * The Delivering → Authenticated → Protected level stays the structure under these words (see LevelLadder).
 */
export type StatusKind = "attention" | "improve" | "unknown" | "verified" | "note" | "prepared" | "approval" | "gathering";

type Tone = "danger" | "warning" | "neutral" | "success" | "info";

export interface StatusDef {
	label: string;
	/** Who acts next, in plain words. */
	next: string;
	tone: Tone;
	Icon: LucideIcon;
}

export const STATUS: Record<StatusKind, StatusDef> = {
	attention: { label: "Needs attention", next: "You, or whoever manages your DNS, acts next.", tone: "danger", Icon: XCircle },
	improve: { label: "Worth fixing", next: "Not urgent. You, or whoever manages your DNS, decides when to change it.", tone: "warning", Icon: AlertTriangle },
	unknown: { label: "Unknown", next: "Public DNS cannot settle this on its own: the answer comes from a retry, your sending service or reports.", tone: "neutral", Icon: CircleHelp },
	verified: { label: "Verified", next: "Nothing to do.", tone: "success", Icon: CheckCircle2 },
	note: { label: "Note", next: "For information. Nobody needs to act.", tone: "info", Icon: Info },
	prepared: { label: "Change prepared", next: "The change is written. Publishing it in DNS is the next step.", tone: "info", Icon: FileText },
	approval: { label: "Awaiting your approval", next: "You act next: approve the change or ask about it.", tone: "warning", Icon: CircleArrowRight },
	gathering: { label: "Still gathering evidence", next: "Nobody acts yet. Reports are still coming in.", tone: "neutral", Icon: Clock },
};

/** Most urgent first. A list sorted by this puts what needs a person at the top. */
export const STATUS_RANK: readonly StatusKind[] = ["attention", "approval", "improve", "unknown", "gathering", "prepared", "verified", "note"];

/** The state that decides a whole result: the first that needs someone. Empty or notes only reads as verified. */
export function worstStatus(kinds: readonly StatusKind[]): StatusKind {
	const found = STATUS_RANK.find((k) => kinds.includes(k));
	return !found || found === "note" ? "verified" : found;
}

export const statusRank = (k: StatusKind): number => STATUS_RANK.indexOf(k);

/** The existing per-check components, read in the shared words. "Not found" and "Lookup failed" stay distinct below. */
export const STATUS_FROM_CHECK: Record<CheckStatus, StatusKind> = {
	pass: "verified",
	warn: "improve",
	fail: "attention",
	missing: "attention",
	neutral: "note",
	error: "unknown",
};

export const STATUS_FROM_FINDING: Record<FindingStatus, StatusKind> = {
	pass: "verified",
	warn: "improve",
	fail: "attention",
	missing: "attention",
	unknown: "unknown",
};

/** For places that still render a StatusDot or a Badge. */
export const STATUS_DOT: Record<StatusKind, StatusDotStatus> = {
	attention: "fail",
	improve: "warn",
	unknown: "unknown",
	verified: "ok",
	note: "info",
	prepared: "info",
	approval: "warn",
	gathering: "unknown",
};

export const STATUS_BADGE: Record<StatusKind, NonNullable<BadgeProps["variant"]>> = {
	attention: "danger",
	improve: "warning",
	unknown: "neutral",
	verified: "success",
	note: "brand",
	prepared: "brand",
	approval: "warning",
	gathering: "neutral",
};

const TONE_TEXT: Record<Tone, string> = {
	danger: "text-danger",
	warning: "text-warning",
	neutral: "text-ink-2",
	success: "text-success",
	info: "text-brand-ink",
};

export function StatusIcon({ kind, className }: { kind: StatusKind; className?: string }) {
	const { Icon, tone } = STATUS[kind];
	return <Icon aria-hidden className={cn("size-4 shrink-0", TONE_TEXT[tone], className)} />;
}

export interface StatusLabelProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
	kind: StatusKind;
	/** Overrides the word for one context; rarely needed. */
	label?: string;
}

/** Icon plus the visible word. The word is the meaning; the colour only repeats it. */
export const StatusLabel = React.forwardRef<HTMLSpanElement, StatusLabelProps>(({ kind, label, className, ...props }, ref) => (
	<span ref={ref} data-status={kind} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold", TONE_TEXT[STATUS[kind].tone], className)} {...props}>
		<StatusIcon kind={kind} />
		{label ?? STATUS[kind].label}
	</span>
));
StatusLabel.displayName = "StatusLabel";
