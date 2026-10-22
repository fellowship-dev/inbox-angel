import type { ReactNode } from 'react';

/** A native radio dressed as a selectable card; the checked state is a thicker border plus the filled radio, not colour alone. */
export function RadioCard({
	name,
	value,
	checked,
	onChange,
	title,
	badge,
	children,
	disabled,
}: {
	name: string;
	value: string;
	checked: boolean;
	onChange: (value: string) => void;
	title: ReactNode;
	badge?: ReactNode;
	children?: ReactNode;
	disabled?: boolean;
}) {
	return (
		<label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface-1 p-4 has-checked:border-2 has-checked:border-brand has-checked:bg-brand-subtle has-checked:p-[calc(1rem-1px)] has-disabled:cursor-not-allowed has-disabled:opacity-60">
			<input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} className="mt-1 size-4 shrink-0" />
			<span className="min-w-0 space-y-1">
				<span className="flex flex-wrap items-center gap-2 font-semibold text-ink-1">
					{title}
					{badge}
				</span>
				{children ? <span className="block text-sm text-ink-2">{children}</span> : null}
			</span>
		</label>
	);
}
