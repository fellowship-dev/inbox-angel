import { Badge, RecordBlock } from '@inbox-angel/ui';
import { AlertTriangle, CheckCircle2, CircleHelp, SearchX, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { PURPOSE_LABEL, PURPOSE_ORDER, pointerStateLabel, type HostedPointer, type HostedStatus, type PointerState } from '../../lib/hosted';
import { timeAgo } from '../../lib/format';

const BADGE: Record<NonNullable<PointerState> | 'unchecked', { variant: 'success' | 'warning' | 'danger' | 'outline'; icon: ReactNode }> = {
	ok: { variant: 'success', icon: <CheckCircle2 aria-hidden className="size-3.5" /> },
	missing: { variant: 'danger', icon: <SearchX aria-hidden className="size-3.5" /> },
	wrong: { variant: 'warning', icon: <AlertTriangle aria-hidden className="size-3.5" /> },
	error: { variant: 'outline', icon: <XCircle aria-hidden className="size-3.5" /> },
	unchecked: { variant: 'outline', icon: <CircleHelp aria-hidden className="size-3.5" /> },
};

/** Icon plus words: the state is never conveyed by colour alone. */
export function PointerBadge({ state }: { state: PointerState | undefined }) {
	const b = BADGE[state ?? 'unchecked'];
	return (
		<Badge variant={b.variant} className="gap-1">
			{b.icon}
			{pointerStateLabel(state)}
		</Badge>
	);
}

export const lastChecked = (at: number | null | undefined) => (at ? `Last checked ${timeAgo(at)}` : 'Not checked yet');

/** The records the customer adds in their own DNS, each with the live result of looking for it. */
export function PointerList({ status }: { status: HostedStatus }) {
	const pointers = [...status.pointers].sort((a: HostedPointer, b: HostedPointer) => PURPOSE_ORDER.indexOf(a.purpose) - PURPOSE_ORDER.indexOf(b.purpose));
	return (
		<ul aria-label="Pointer records" className="space-y-3">
			{pointers.map((p) => (
				<li key={`${p.purpose}-${p.type}-${p.name}`} className="space-y-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="text-sm font-medium text-ink-1">{PURPOSE_LABEL[p.purpose]}</p>
						<PointerBadge state={status.pointer_status[p.purpose]} />
					</div>
					<RecordBlock title={p.purpose === 'spf' ? 'Add to your existing SPF record' : `Add this ${p.type} record`} record={{ type: p.type, name: p.name, value: p.value }} />
				</li>
			))}
		</ul>
	);
}
