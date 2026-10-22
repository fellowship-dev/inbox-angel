"use client";

import { cva } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, CircleHelp, CircleSlash, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./button.js";

/**
 * - pass / warn / fail: we looked up the record and judged it.
 * - missing: the lookup worked and the record is not there (a finding).
 * - error: the lookup itself failed (timeout, SERVFAIL, resolver down). We do NOT know if the record exists.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "missing" | "error";

export const checkStatusMeta: Record<CheckStatus, { label: string; icon: LucideIcon }> = {
	pass: { label: "Pass", icon: CheckCircle2 },
	warn: { label: "Warning", icon: AlertTriangle },
	fail: { label: "Fail", icon: XCircle },
	missing: { label: "Not found", icon: CircleSlash },
	error: { label: "Lookup failed", icon: CircleHelp },
};

const row = cva("flex gap-3 rounded-lg border p-4", {
	variants: {
		status: {
			pass: "border-line bg-surface-1",
			warn: "border-warning/40 bg-warning-subtle",
			fail: "border-danger/40 bg-danger-subtle",
			missing: "border-danger/40 bg-danger-subtle",
			// Neutral + dashed: "we could not check" must not read as pass or fail.
			error: "border-dashed border-ink-3 bg-surface-2",
		},
	},
});

const iconTone: Record<CheckStatus, string> = {
	pass: "text-success",
	warn: "text-warning",
	fail: "text-danger",
	missing: "text-danger",
	error: "text-ink-2",
};
const labelTone: Record<CheckStatus, string> = {
	pass: "text-success",
	warn: "text-warning",
	fail: "text-danger",
	missing: "text-danger",
	error: "text-ink-1",
};

export interface CheckResultProps extends Omit<React.HTMLAttributes<HTMLLIElement>, "title"> {
	status: CheckStatus;
	/** What was checked: "SPF", "DMARC policy". */
	title: React.ReactNode;
	/** One plain-language sentence about the result. */
	summary?: React.ReactNode;
	/** Extra detail: a record, a parsed value, a fix. */
	children?: React.ReactNode;
	/** Overrides the status word (e.g. "Pass (p=quarantine)"). */
	statusLabel?: string;
	/** For `error`: re-run the lookup. */
	onRetry?: () => void;
}

/** A single result row; render inside <CheckResultList>. Icon + word carry the meaning, colour only reinforces. */
export const CheckResult = React.forwardRef<HTMLLIElement, CheckResultProps>(
	({ className, status, title, summary, children, statusLabel, onRetry, ...props }, ref) => {
		const { label, icon: Icon } = checkStatusMeta[status];
		return (
			<li ref={ref} data-status={status} className={cn(row({ status }), className)} {...props}>
				<Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", iconTone[status])} />
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex flex-wrap items-baseline gap-x-2">
						<span className="font-semibold text-ink-1">{title}</span>
						<span className={cn("text-sm font-medium", labelTone[status])}>
							<span className="sr-only">: </span>
							{statusLabel ?? label}
						</span>
					</div>
					{summary ? <p className="text-sm text-ink-2">{summary}</p> : null}
					{status === "error" ? (
						<p className="text-sm text-ink-2">We could not check this, so we cannot tell whether the record exists. Nothing is assumed missing.</p>
					) : null}
					{children ? <div className="text-sm text-ink-1">{children}</div> : null}
					{status === "error" && onRetry ? (
						<Button variant="secondary" size="sm" onClick={onRetry}>
							<RefreshCw aria-hidden />
							Try again
						</Button>
					) : null}
				</div>
			</li>
		);
	},
);
CheckResult.displayName = "CheckResult";

export const CheckResultList = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
	({ className, ...props }, ref) => <ul ref={ref} className={cn("flex list-none flex-col gap-2 p-0", className)} {...props} />,
);
CheckResultList.displayName = "CheckResultList";
