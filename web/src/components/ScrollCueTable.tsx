import { Table, cn } from '@ready-set-mail/ui';
import { ArrowLeftRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useScrollEdges } from '../lib/layout';

/**
 * A table that can be wider than its box. A cut-off column is never silent: the label shows on phones and whenever
 * the table overflows, and the edge that hides columns gets a control-strength hairline.
 */
export function ScrollCueTable({ label, children }: { label: string; children: ReactNode }) {
	const [tableRef, edges] = useScrollEdges<HTMLTableElement>();
	return (
		<div className="space-y-2">
			<p className={cn('items-center gap-1.5 text-xs text-ink-2', edges.left || edges.right ? 'flex' : 'flex sm:hidden')}>
				<ArrowLeftRight aria-hidden className="size-4 shrink-0" />
				Scroll sideways to see every column.
			</p>
			<Table ref={tableRef} label={label} containerClassName={cn(edges.left && 'border-l-control', edges.right && 'border-r-control')}>
				{children}
			</Table>
		</div>
	);
}
