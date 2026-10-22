"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";

export const ToastProvider = ToastPrimitive.Provider;
export const ToastAction = ToastPrimitive.Action;

export const ToastViewport = React.forwardRef<
	React.ComponentRef<typeof ToastPrimitive.Viewport>,
	React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
	<ToastPrimitive.Viewport
		ref={ref}
		className={cn("fixed bottom-0 right-0 z-[100] m-0 flex max-h-screen w-full max-w-sm list-none flex-col gap-2 p-4 outline-none", className)}
		{...props}
	/>
));
ToastViewport.displayName = "ToastViewport";

export type ToastVariant = "info" | "success" | "warning" | "danger";

const variantClasses: Record<ToastVariant, string> = {
	info: "[&_svg.ia-toast-icon]:text-brand-ink",
	success: "[&_svg.ia-toast-icon]:text-success",
	warning: "[&_svg.ia-toast-icon]:text-warning",
	danger: "[&_svg.ia-toast-icon]:text-danger",
};
const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

export interface ToastProps extends Omit<React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>, "title"> {
	variant?: ToastVariant;
	title?: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
}

export const Toast = React.forwardRef<React.ComponentRef<typeof ToastPrimitive.Root>, ToastProps>(
	({ className, variant = "info", title, description, action, children, ...props }, ref) => {
		const Icon = icons[variant];
		return (
			<ToastPrimitive.Root
				ref={ref}
				className={cn(
					"ia-slide-up relative flex items-start gap-3 rounded-lg border border-line-strong bg-surface-1 p-4 pr-10 text-ink-1 shadow-pop data-[state=closed]:ia-fade-out",
					variantClasses[variant],
					className,
				)}
				{...props}
			>
				<Icon aria-hidden className="ia-toast-icon mt-0.5 size-5 shrink-0" />
				<div className="min-w-0 flex-1 space-y-1">
					{title ? <ToastPrimitive.Title className="text-sm font-semibold">{title}</ToastPrimitive.Title> : null}
					{description ? <ToastPrimitive.Description className="text-sm text-ink-2">{description}</ToastPrimitive.Description> : null}
					{children}
					{action ? <div className="pt-1">{action}</div> : null}
				</div>
				<ToastPrimitive.Close
					aria-label="Dismiss"
					className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1"
				>
					<X aria-hidden className="size-4" />
				</ToastPrimitive.Close>
			</ToastPrimitive.Root>
		);
	},
);
Toast.displayName = "Toast";

// ── Imperative API (shadcn-style): call `toast({...})` anywhere, mount <Toaster /> once. ──

export interface ToastOptions {
	title?: React.ReactNode;
	description?: React.ReactNode;
	variant?: ToastVariant;
	duration?: number;
	action?: React.ReactNode;
}
interface ToastItem extends ToastOptions {
	id: number;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(options: ToastOptions): { id: number; dismiss: () => void } {
	const id = nextId++;
	items = [...items, { ...options, id }].slice(-5);
	emit();
	return { id, dismiss: () => dismissToast(id) };
}
export function dismissToast(id: number): void {
	items = items.filter((t) => t.id !== id);
	emit();
}

export function useToasts(): ToastItem[] {
	return React.useSyncExternalStore(
		(cb) => (listeners.add(cb), () => void listeners.delete(cb)),
		() => items,
		() => items,
	);
}

/** Mount once near the app root. Error toasts last longer; all can be dismissed with the close button or Esc. */
export function Toaster({ viewportClassName }: { viewportClassName?: string }) {
	const toasts = useToasts();
	return (
		<ToastProvider swipeDirection="right" label="Notifications">
			{toasts.map(({ id, duration, variant, ...rest }) => (
				<Toast
					key={id}
					variant={variant}
					duration={duration ?? (variant === "danger" ? 10000 : 5000)}
					onOpenChange={(open) => !open && dismissToast(id)}
					{...rest}
				/>
			))}
			<ToastViewport className={viewportClassName} />
		</ToastProvider>
	);
}
