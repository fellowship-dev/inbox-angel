"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import { Badge } from "./badge.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu.js";

export interface SwitcherWorkspace {
	id: string;
	name: string;
	role: "owner" | "admin" | "member";
}

export interface WorkspaceSwitcherProps {
	current: SwitcherWorkspace | null;
	workspaces: SwitcherWorkspace[];
	onSelect: (id: string) => void;
	/** Shows the "Create workspace" entry when given. */
	onCreate?: () => void;
	/** Only the first letter, for a collapsed sidebar. */
	compact?: boolean;
	className?: string;
}

/**
 * Pick the workspace you are working in: the current one on the button, every workspace you
 * belong to (with your role in it) in the menu, and a way to make a new one.
 */
export function WorkspaceSwitcher({ current, workspaces, onSelect, onCreate, compact, className }: WorkspaceSwitcherProps) {
	const name = current?.name ?? "Workspace";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`Workspace: ${name}. Switch workspace`}
					className={cn(
						"flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-line bg-surface-0 px-2 text-left text-sm font-medium text-ink-1 transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2",
						compact && "w-10 justify-center px-0",
						className,
					)}
				>
					<span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded bg-brand-subtle text-xs font-semibold uppercase text-brand-ink">
						{name.trim().charAt(0) || "W"}
					</span>
					{compact ? null : (
						<>
							<span className="min-w-0 flex-1 truncate">{name}</span>
							<ChevronsUpDown aria-hidden className="size-4 shrink-0 text-ink-2" />
						</>
					)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-ink-2">Workspaces</DropdownMenuLabel>
				{workspaces.map((w) => {
					const isCurrent = w.id === current?.id;
					return (
						<DropdownMenuItem key={w.id} aria-current={isCurrent ? "true" : undefined} onSelect={() => !isCurrent && onSelect(w.id)}>
							<span className="min-w-0 flex-1 truncate">{w.name}</span>
							<Badge variant={w.role === "member" ? "neutral" : "brand"}>{w.role}</Badge>
							<Check aria-hidden className={cn("text-brand-ink", !isCurrent && "invisible")} />
						</DropdownMenuItem>
					);
				})}
				{onCreate ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={onCreate}>
							<Plus aria-hidden />
							Create workspace
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
