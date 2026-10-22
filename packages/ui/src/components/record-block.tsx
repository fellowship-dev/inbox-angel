"use client";

import { Check, Copy } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import { IconButton } from "./icon-button.js";

export interface DnsRecord {
	/** TXT, CNAME, MX … */
	type: string;
	/** Host, e.g. "_dmarc" or "@". */
	name: string;
	value: string;
	ttl?: number | string;
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Fallback for insecure contexts / older browsers.
		const el = document.createElement("textarea");
		el.value = text;
		el.setAttribute("readonly", "");
		el.style.position = "fixed";
		el.style.opacity = "0";
		document.body.appendChild(el);
		el.select();
		const ok = document.execCommand?.("copy") ?? false;
		el.remove();
		return ok;
	}
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = React.useState(false);
	const [announcement, setAnnouncement] = React.useState("");
	const resetTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const announceTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	React.useEffect(
		() => () => {
			clearTimeout(resetTimer.current);
			clearTimeout(announceTimer.current);
		},
		[],
	);
	return (
		<>
			{/* The button name stays fixed; the live region does the announcing (once per copy). */}
			<IconButton
				size="sm"
				variant="ghost"
				label={label}
				onClick={async () => {
					if (!(await copyText(text))) return;
					setCopied(true);
					// Clear, then set on a later tick, so a repeat copy is announced again.
					setAnnouncement("");
					clearTimeout(announceTimer.current);
					announceTimer.current = setTimeout(() => setAnnouncement("Copied to clipboard"), 50);
					clearTimeout(resetTimer.current);
					resetTimer.current = setTimeout(() => {
						setCopied(false);
						setAnnouncement("");
					}, 2000);
				}}
			>
				{copied ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
			</IconButton>
			<span role="status" aria-live="polite" className="sr-only">
				{announcement}
			</span>
		</>
	);
}

export interface RecordBlockProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	record: DnsRecord;
	/** Caption above the block: "Add this TXT record at your DNS provider". */
	title?: React.ReactNode;
}

/** A DNS record as content: monospace, selectable, each field copyable. */
export const RecordBlock = React.forwardRef<HTMLDivElement, RecordBlockProps>(({ className, record, title, ...props }, ref) => {
	const rows: Array<{ key: string; label: string; value: string; copy: boolean }> = [
		{ key: "type", label: "Type", value: record.type, copy: false },
		{ key: "name", label: "Name", value: record.name, copy: true },
		{ key: "value", label: "Value", value: record.value, copy: true },
	];
	if (record.ttl !== undefined) rows.push({ key: "ttl", label: "TTL", value: String(record.ttl), copy: false });
	return (
		<div ref={ref} className={cn("overflow-hidden rounded-lg border border-line bg-surface-2", className)} {...props}>
			{title ? <p className="border-b border-line px-4 py-2 text-sm font-medium text-ink-1">{title}</p> : null}
			<dl className="divide-y divide-line">
				{rows.map((r) => (
					<div key={r.key} className="grid grid-cols-[4.5rem_1fr] items-start gap-x-3 px-4 py-2 sm:grid-cols-[5rem_1fr]">
						<dt className="pt-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">{r.label}</dt>
						<dd className="flex min-w-0 items-start justify-between gap-2">
							<span className="min-w-0 py-1 font-mono text-sm leading-relaxed text-ink-1 [overflow-wrap:anywhere]">{r.value}</span>
							{r.copy ? <CopyButton text={r.value} label={`Copy ${r.label.toLowerCase()}`} /> : <span className="size-8 shrink-0" />}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
});
RecordBlock.displayName = "RecordBlock";
