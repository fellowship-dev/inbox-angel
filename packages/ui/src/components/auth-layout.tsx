import * as React from "react";
import { cn } from "../lib/cn.js";
import { Card, CardContent } from "./card.js";
import { LogoMark } from "./logo.js";

export interface AuthLayoutProps {
	title: string;
	description?: React.ReactNode;
	children: React.ReactNode;
	/** Product name next to the mark. */
	brandName?: string;
	className?: string;
}

/**
 * Sign-in / owner setup / reset frame. Phones: content starts at the top (keyboard-safe) and the card
 * runs edge to edge; from `sm` the card is centred and framed. One h1, the card title.
 */
export function AuthLayout({ title, description, children, brandName = "Inbox Angel", className }: AuthLayoutProps) {
	return (
		<main className={cn("flex min-h-screen flex-col items-center bg-surface-0 px-0 py-8 text-ink-1 sm:justify-center sm:px-6 sm:py-14", className)}>
			<div className="w-full max-w-md space-y-6">
				<div className="flex items-center justify-center gap-2.5 px-4 text-lg font-semibold tracking-tight sm:px-0">
					<LogoMark className="size-9 shrink-0 rounded-md" />
					{brandName}
				</div>
				<Card className="rounded-none border-x-0 shadow-none sm:rounded-lg sm:border-x sm:shadow-lift">
					<CardContent className="space-y-6 p-5 sm:p-8">
						<div className="space-y-2">
							<h1 className="text-balance [overflow-wrap:anywhere] text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
							{description ? <p className="text-sm text-ink-2">{description}</p> : null}
						</div>
						{children}
					</CardContent>
				</Card>
			</div>
		</main>
	);
}

export interface FieldProps {
	id: string;
	label: React.ReactNode;
	hint?: React.ReactNode;
	children: React.ReactNode;
}

/** Label + control + hint. The hint gets id `${id}-hint`: point the control's aria-describedby at it. */
export function Field({ id, label, hint, children }: FieldProps) {
	return (
		<div className="space-y-2">
			<label htmlFor={id} className="block text-sm font-medium leading-none text-ink-1">
				{label}
			</label>
			{children}
			{hint ? (
				<p id={`${id}-hint`} className="text-sm text-ink-2">
					{hint}
				</p>
			) : null}
		</div>
	);
}
