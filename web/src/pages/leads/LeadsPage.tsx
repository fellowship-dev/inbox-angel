import { Alert, Badge, EmptyState, PageHeader } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { MailPlus } from 'lucide-react';
import { ListSkeleton, LoadError } from '../../components/states';
import { api, ApiError } from '../../lib/api';
import { formatTimestamp } from '../../lib/reports';
import type { LeadRow, LeadsResponse } from '../../lib/types';

const LEVEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
	protected: { label: 'Protected', tone: 'success' },
	at_risk: { label: 'At risk', tone: 'warning' },
	exposed: { label: 'Exposed', tone: 'danger' },
};

function statusLabel(l: LeadRow): string {
	return l.status === 'active' ? `Step ${l.step} of ${l.steps_total}` : l.status === 'completed' ? 'Sequence finished' : l.status.charAt(0).toUpperCase() + l.status.slice(1);
}

export function LeadsPage() {
	const q = useQuery({ queryKey: ['leads'], queryFn: () => api<LeadsResponse>('/api/leads') });
	const forbidden = q.error instanceof ApiError && q.error.status === 403;

	return (
		<div className="space-y-6">
			<PageHeader title="Leads" description="People who sent a free email check and are in the onboarding sequence. Instance owner only." />

			{forbidden ? (
				<Alert variant="info" title="Only the instance owner can see leads">
					Leads are the operator's marketing data, not a workspace's. They are visible to the account in OWNER_EMAIL (or the owner of a self-hosted instance).
				</Alert>
			) : q.isPending ? (
				<ListSkeleton rows={6} label="Loading leads" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the leads" />
			) : (
				<LeadsTable data={q.data} />
			)}
		</div>
	);
}

function LeadsTable({ data }: { data: LeadsResponse }) {
	return (
		<>
			{!data.delivery.enabled ? (
				<Alert variant="info" title="The onboarding sequence is off">
					{data.delivery.blockers[0]}
				</Alert>
			) : !data.delivery.can_send ? (
				<Alert variant="warning" title="Emails are queued, not sent">
					<ul className="list-disc pl-5">
						{data.delivery.blockers.map((b) => (
							<li key={b}>{b}</li>
						))}
					</ul>
				</Alert>
			) : null}
			{data.delivery.enabled && data.delivery.warnings.length > 0 ? (
				<Alert variant="info" title="Worth setting">
					<ul className="list-disc pl-5">
						{data.delivery.warnings.map((w) => (
							<li key={w}>{w}</li>
						))}
					</ul>
				</Alert>
			) : null}

			{data.leads.length === 0 ? (
				<EmptyState icon={<MailPlus />} title="No leads yet" description="Someone who sends a free check, and is not suppressed, appears here with their place in the sequence." />
			) : (
				<div className="overflow-x-auto rounded-lg border border-line bg-surface-1">
					<table className="w-full text-left text-sm">
						<thead className="border-b border-line text-xs uppercase text-ink-2">
							<tr>
								<th className="px-4 py-2 font-medium">Domain</th>
								<th className="px-4 py-2 font-medium">Email</th>
								<th className="px-4 py-2 font-medium">Level</th>
								<th className="px-4 py-2 font-medium">Sequence</th>
								<th className="px-4 py-2 font-medium">Next email</th>
							</tr>
						</thead>
						<tbody>
							{data.leads.map((l) => (
								<tr key={l.id} className="border-b border-line last:border-0">
									<td className="px-4 py-2 [overflow-wrap:anywhere]">{l.domain}</td>
									<td className="px-4 py-2 [overflow-wrap:anywhere]">{l.email}</td>
									<td className="px-4 py-2">{l.level ? <Badge variant={LEVEL[l.level]?.tone ?? 'neutral'}>{LEVEL[l.level]?.label ?? l.level}</Badge> : '—'}</td>
									<td className="px-4 py-2">{statusLabel(l)}</td>
									<td className="px-4 py-2 whitespace-nowrap">{l.status === 'active' && l.next_send_at ? formatTimestamp(l.next_send_at) : '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</>
	);
}
