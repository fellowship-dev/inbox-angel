import * as React from "react";
import { cn } from "../lib/cn.js";

export const controlClasses =
	"w-full rounded-md border border-control bg-surface-1 px-3 text-sm text-ink-1 placeholder:text-ink-3 transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger aria-[invalid=true]:border-2";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type = "text", ...props }, ref) => (
	<input ref={ref} type={type} className={cn(controlClasses, "h-10", className)} {...props} />
));
Input.displayName = "Input";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
	<textarea ref={ref} className={cn(controlClasses, "min-h-24 py-2 leading-relaxed", className)} {...props} />
));
Textarea.displayName = "Textarea";
