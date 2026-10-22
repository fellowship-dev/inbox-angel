import { cva } from "class-variance-authority";

// Kept apart from button.tsx ("use client") so server components can call it.
export const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				// Brand FILL with navy text (white on #60a5fa fails AA).
				primary: "bg-brand text-brand-fg hover:bg-brand-hover",
				secondary: "border border-line-strong bg-surface-1 text-ink-1 hover:bg-surface-2",
				ghost: "text-ink-1 hover:bg-surface-2",
				danger: "border border-danger bg-danger-subtle text-danger hover:bg-surface-2",
				link: "rounded-sm text-brand-ink underline underline-offset-4 hover:text-ink-1",
			},
			size: {
				sm: "h-8 px-3 text-sm [&_svg]:size-4",
				md: "h-10 px-4 text-sm [&_svg]:size-4",
				lg: "h-12 px-6 text-base [&_svg]:size-5",
			},
		},
		defaultVariants: { variant: "primary", size: "md" },
	},
);
