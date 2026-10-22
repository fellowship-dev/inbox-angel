import { Badge, RecordBlock, cn, type DnsRecord } from '@inbox-angel/ui';
import type { ReactNode } from 'react';

/** A TXT value with a caption and an optional badge ("12 / 10 lookups"). */
export function TxtRecord({ title, value, name = '@', badge, className }: { title: ReactNode; value: string; name?: string; badge?: ReactNode; className?: string }) {
	const record: DnsRecord = { type: 'TXT', name, value };
	return (
		<div className={cn('min-w-0 space-y-1.5', className)}>
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-sm font-medium text-ink-1">{title}</p>
				{badge}
			</div>
			<RecordBlock record={record} />
		</div>
	);
}

/** Two records side by side from `md` up, stacked on phones. */
export function RecordPair({ children }: { children: ReactNode }) {
	return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

export function LookupBadge({ count, estimate = false, suffix = 'lookups' }: { count: number; estimate?: boolean; suffix?: string }) {
	const variant = count > 9 ? 'danger' : count >= 8 ? 'warning' : 'success';
	const word = count > 10 ? 'over the limit' : count > 9 ? 'at the limit' : count >= 8 ? 'close to the limit' : 'within the limit';
	return (
		<Badge variant={variant}>
			{estimate ? '~' : ''}
			{count} / 10 {suffix}
			<span className="sr-only">, {word}</span>
		</Badge>
	);
}
