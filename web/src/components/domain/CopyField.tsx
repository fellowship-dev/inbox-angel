import { IconButton, toast } from '@inbox-angel/ui';
import { Copy } from 'lucide-react';

/** A labelled, selectable value with a copy button (for values that are not a whole DNS record). */
export function CopyField({ label, value }: { label: string; value: string }) {
	return (
		<div className="space-y-1">
			<p className="text-xs font-semibold uppercase tracking-wide text-ink-2">{label}</p>
			<div className="flex items-start justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-1">
				<code className="min-w-0 py-1.5 font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">{value}</code>
				<IconButton
					size="sm"
					label={`Copy ${label.toLowerCase()}`}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(value);
							toast({ title: 'Copied to clipboard', variant: 'success', duration: 2000 });
						} catch {
							toast({ title: 'Could not copy', description: 'Select the text and copy it by hand.', variant: 'warning' });
						}
					}}
				>
					<Copy aria-hidden />
				</IconButton>
			</div>
		</div>
	);
}
