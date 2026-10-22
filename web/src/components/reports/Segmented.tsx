import { cn } from '@inbox-angel/ui';
import type { ReactNode } from 'react';

export interface SegmentedOption<T> {
	value: T;
	label: ReactNode;
	/** Plain-text name for assistive tech when `label` carries extra content (a count). */
	name?: string;
}

/** A row of toggle buttons where exactly one is pressed (filters and windows; not navigation). */
export function Segmented<T extends string | number | null>({
	label,
	options,
	value,
	onChange,
	className,
}: {
	label: string;
	options: Array<SegmentedOption<T>>;
	value: T;
	onChange: (value: T) => void;
	className?: string;
}) {
	return (
		<div role="group" aria-label={label} className={cn('inline-flex flex-wrap gap-1 rounded-lg border border-line bg-surface-2 p-1', className)}>
			{options.map((o) => {
				const pressed = o.value === value;
				return (
					<button
						key={String(o.value)}
						type="button"
						aria-pressed={pressed}
						aria-label={o.name}
						onClick={() => onChange(o.value)}
						className={cn(
							'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
							pressed ? 'bg-surface-1 text-ink-1 shadow-soft' : 'text-ink-2 hover:text-ink-1',
						)}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}
