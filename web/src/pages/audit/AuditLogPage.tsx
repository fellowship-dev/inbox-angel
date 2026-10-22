import { Alert, Badge, Button, EmptyState, PageHeader } from '@inbox-angel/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Segmented } from '../../components/reports';
import { ListSkeleton, LoadError } from '../../components/states';
import { api, ApiError } from '../../lib/api';
import { actionTone, AUDIT_FILTERS, AUDIT_PAGE_SIZE, formatTimestamp, prettyJson, relativeTime } from '../../lib/reports';
import type { AuditLogEntry } from '../../lib/types';

function JsonDetails({ label, value }: { label: string; value: string | null }) {
	if (!value) return null;
	return (
		<details className="group min-w-0">
			<summary className="cursor-pointer select-none rounded-sm text-xs font-medium text-ink-2 hover:text-ink-1">{label}</summary>
			<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 p-3 font-mono text-xs text-ink-1">{prettyJson(value)}</pre>
		</details>
	);
}

function EntryRow({ entry }: { entry: AuditLogEntry }) {
	const system = entry.actor_type === 'system';
	return (
		<li className="space-y-1.5 border-b border-line px-4 py-3 last:border-0">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<Badge variant={actionTone(entry.action)} className="font-mono">
					{entry.action}
				</Badge>
				{entry.resource_name ? <span className="min-w-0 text-sm text-ink-1 [overflow-wrap:anywhere]">{entry.resource_name}</span> : null}
				<div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-2 sm:ml-auto">
					<span>
						<span className="sr-only">By </span>
						{system ? <em>system</em> : (entry.actor_email ?? entry.actor_id ?? '—')}
					</span>
					<time dateTime={new Date(entry.created_at * 1000).toISOString()} className="whitespace-nowrap">
						{formatTimestamp(entry.created_at)} · {relativeTime(entry.created_at)}
					</time>
				</div>
			</div>
			{entry.before_value || entry.after_value ? (
				<div className="flex flex-wrap gap-x-6 gap-y-1">
					<JsonDetails label="before" value={entry.before_value} />
					<JsonDetails label="after" value={entry.after_value} />
				</div>
			) : null}
		</li>
	);
}

export function AuditLogPage() {
	const [action, setAction] = useState('');
	const [page, setPage] = useState(1);

	const q = useQuery({
		queryKey: ['audit-log', page, action],
		queryFn: () => api<{ entries: AuditLogEntry[]; page: number; limit: number }>(`/api/audit-log?page=${page}&limit=${AUDIT_PAGE_SIZE}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
		placeholderData: keepPreviousData,
	});

	useEffect(() => {
		window.scrollTo?.({ top: 0 });
	}, [page]);

	const forbidden = q.error instanceof ApiError && q.error.status === 403;
	const entries = q.data?.entries ?? [];
	const hasMore = entries.length === AUDIT_PAGE_SIZE;

	return (
		<div className="space-y-6">
			<PageHeader title="Audit log" description="Immutable record of all changes. Admin only." />

			{forbidden ? (
				<Alert variant="info" title="Only owners and admins can see the audit log">
					Your role is member. Ask an owner or admin if you need to know who changed something.
				</Alert>
			) : (
				<>
					<Segmented
						label="Filter by area"
						value={action}
						onChange={(v) => {
							setAction(v);
							setPage(1);
						}}
						options={AUDIT_FILTERS.map((f) => ({ value: f.value as string, label: f.label }))}
					/>

					{q.isPending ? (
						<ListSkeleton rows={6} label="Loading audit log" />
					) : q.isError ? (
						<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the audit log" />
					) : entries.length === 0 ? (
						<EmptyState
							icon={<ScrollText />}
							title={page > 1 ? 'No more entries' : action ? 'No entries for this filter' : 'No audit entries yet'}
							description={page > 1 ? 'You have reached the end of the log.' : 'Sign-ins, DNS changes and settings changes will be recorded here as they happen.'}
							action={
								page > 1 ? (
									<Button variant="secondary" onClick={() => setPage(1)}>
										Back to the first page
									</Button>
								) : action ? (
									<Button variant="secondary" onClick={() => setAction('')}>
										Show all
									</Button>
								) : undefined
							}
						/>
					) : (
						<>
							<ul className="overflow-hidden rounded-lg border border-line bg-surface-1" aria-busy={q.isPlaceholderData}>
								{entries.map((e) => (
									<EntryRow key={e.id} entry={e} />
								))}
							</ul>
							<nav aria-label="Pagination" className="flex items-center justify-between gap-3">
								<Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
									<ChevronLeft aria-hidden />
									Previous
								</Button>
								<span className="text-sm text-ink-2">Page {page}</span>
								<Button variant="secondary" size="sm" disabled={!hasMore} onClick={() => setPage((p) => p + 1)}>
									Next
									<ChevronRight aria-hidden />
								</Button>
							</nav>
						</>
					)}
				</>
			)}
		</div>
	);
}
