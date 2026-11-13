import { Button, Skeleton, StatusLabel } from '@inbox-angel/ui';
import { RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import type { DomainAction } from '../../lib/actions';

/** The top of a domain page: one to three actions, each as Do this / Why, with who acts and where. */
export function DoThisNext({ actions, pending, canWrite, onRetry }: { actions: DomainAction[]; pending: boolean; canWrite: boolean; onRetry: () => void }) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h2 id={headingId} className="text-lg font-semibold tracking-tight">
				Do this next
			</h2>
			{pending ? (
				<div aria-busy="true" role="status" className="space-y-2 rounded-lg border border-line bg-surface-1 p-5">
					<Skeleton className="h-5 w-2/3" />
					<Skeleton className="h-4 w-1/2" />
					<span className="text-sm text-ink-2">Reading this domain's records from public DNS…</span>
				</div>
			) : (
				<ol className="divide-y divide-line rounded-lg border border-line bg-surface-1">
					{actions.map((a, i) => (
						<li key={a.key} data-status={a.status} className="flex gap-3 px-4 py-4 sm:px-5">
							{actions.length > 1 ? (
								<span aria-hidden className={i === 0 ? 'mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 font-mono text-xs font-semibold text-accent-fg' : 'mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-line-strong px-1.5 font-mono text-xs font-semibold text-ink-2'}>
									{i + 1}
								</span>
							) : null}
							<div className="min-w-0 flex-1 space-y-1.5">
								<StatusLabel kind={a.status} />
								<p className="text-base font-semibold text-ink-1">
									<span className="text-sm font-medium text-ink-2">Do this: </span>
									{a.do}
								</p>
								<p className="max-w-prose text-sm text-ink-2">
									<span className="font-medium text-ink-1">Why: </span>
									{a.why}
								</p>
								<div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-0.5 text-sm">
									<span className="text-ink-2">
										Who: <span className="text-ink-1">{a.who}</span>
									</span>
									{a.retry ? (
										<Button variant="secondary" size="sm" onClick={onRetry}>
											<RefreshCw aria-hidden />
											Check again
										</Button>
									) : a.to && (canWrite || !a.writes) ? (
										<Link to={a.to} className="rounded-sm font-medium text-brand-ink underline underline-offset-4">
											{a.cta ?? 'Open'}
										</Link>
									) : a.to ? (
										<span className="text-ink-2">An owner or admin makes this change.</span>
									) : null}
								</div>
							</div>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
