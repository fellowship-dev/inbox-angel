import { Alert, Badge, Button, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, PauseCircle, PlayCircle, Star } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useDomainId } from '../../app';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { CopyField } from '../../components/domain/CopyField';
import { ListSkeleton, LoadError, PageSkeleton, ReadOnlyNotice, Section, WriteButton } from '../../components/states';
import { ApiError, api, errorMessage } from '../../lib/api';
import { domainKeys, invalidateDomain, useMonitorSubs, type MonitorSub } from '../../lib/domain-queries';
import { downloadFile } from '../../lib/download';
import { formatDate } from '../../lib/format';
import { useDomain, useDomains } from '../../lib/queries';
import type { Domain } from '../../lib/types';

function Info({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-4">
			<dt className="text-sm text-ink-2">{label}</dt>
			<dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{children}</dd>
		</div>
	);
}

function ExportSection({ domain }: { domain: Domain }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Section title="Export data" description="One row per source per day, as CSV. Your key is sent in a header, never in the link.">
			<div className="space-y-3">
				<Button
					variant="secondary"
					loading={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						try {
							await downloadFile(`/api/domains/${domain.id}/export`, `${domain.domain}-dmarc.csv`);
						} catch (e) {
							setError(errorMessage(e));
						} finally {
							setBusy(false);
						}
					}}
				>
					<Download aria-hidden />
					Download CSV
				</Button>
				{error ? (
					<Alert variant="danger" title="Could not download the export">
						{error}
					</Alert>
				) : null}
			</div>
		</Section>
	);
}

function AlertsSection({ domain }: { domain: Domain }) {
	const qc = useQueryClient();
	const subs = useMonitorSubs(domain.id);
	const enabled = !!domain.alerts_enabled;

	const toggleAll = useMutation({
		mutationFn: () => api(`/api/domains/${domain.id}/alerts`, { method: 'PATCH', body: { alerts_enabled: !enabled } }),
		onSuccess: async () => {
			toast({ title: enabled ? 'Alerts paused' : 'Alerts resumed', variant: 'success' });
			await invalidateDomain(qc, domain.id);
		},
	});
	const toggleSub = useMutation({
		mutationFn: (sub: MonitorSub) => api(`/api/monitor-subs/${sub.id}`, { method: 'PATCH', body: { active: !sub.active } }),
		onSuccess: async (_d, sub) => {
			toast({ title: sub.active ? 'Subscriber paused' : 'Subscriber resumed', description: sub.email, variant: 'success' });
			await qc.invalidateQueries({ queryKey: domainKeys.monitorSubs(domain.id) });
		},
	});

	return (
		<Section title="Monitoring alerts" description="Emails sent when something changes for this domain.">
			<Card>
				<CardContent className="flex flex-wrap items-center justify-between gap-3">
					<div className="space-y-0.5">
						<p className="font-medium">Alerts {enabled ? 'enabled' : 'paused'}</p>
						<p className="text-sm text-ink-2">{enabled ? 'Subscribers below receive alerts for this domain.' : 'No alerts are sent for this domain until you resume them.'}</p>
					</div>
					<WriteButton variant="secondary" size="sm" loading={toggleAll.isPending} onClick={() => toggleAll.mutate()}>
						{enabled ? <PauseCircle aria-hidden /> : <PlayCircle aria-hidden />}
						{enabled ? 'Pause all' : 'Resume all'}
					</WriteButton>
				</CardContent>
			</Card>
			{toggleAll.isError ? <Alert variant="danger" title="Could not change alerts">{errorMessage(toggleAll.error)}</Alert> : null}
			{toggleSub.isError ? <Alert variant="danger" title="Could not change this subscriber">{errorMessage(toggleSub.error)}</Alert> : null}

			{subs.isPending ? (
				<ListSkeleton rows={2} label="Loading subscribers" />
			) : subs.isError ? (
				<LoadError error={subs.error} onRetry={() => void subs.refetch()} title="Could not load subscribers" />
			) : subs.data.length === 0 ? (
				<EmptyState title="No monitoring subscribers yet" description="They are created automatically when someone runs a free email check and opts in to alerts." action={<Button asChild variant="secondary"><Link to="/check">Run an email check</Link></Button>} />
			) : (
				<Table label="Monitoring subscribers">
					<TableHeader>
						<TableRow>
							<TableHead>Email</TableHead>
							<TableHead>Status</TableHead>
							<TableHead className="text-right">Action</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{subs.data.map((s) => (
							<TableRow key={s.id}>
								<TableCell className="[overflow-wrap:anywhere]">{s.email}</TableCell>
								<TableCell>
									<Badge variant={s.active ? 'success' : 'outline'}>
										{s.active ? <PlayCircle aria-hidden /> : <PauseCircle aria-hidden />}
										{s.active ? 'Receiving alerts' : 'Alerts paused'}
									</Badge>
								</TableCell>
								<TableCell className="text-right">
									<WriteButton variant="ghost" size="sm" disabled={toggleSub.isPending} onClick={() => toggleSub.mutate(s)}>
										{s.active ? 'Pause' : 'Resume'}
										<span className="sr-only"> {s.email}</span>
									</WriteButton>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</Section>
	);
}

function InfrastructureSection({ domain }: { domain: Domain }) {
	const qc = useQueryClient();
	const [warning, setWarning] = useState<string | null>(null);
	const setDefault = useMutation({
		mutationFn: () => api<{ ok: boolean; domain: string; warning: string }>(`/api/domains/${domain.id}/set-default`, { method: 'PUT' }),
		onSuccess: async (res) => {
			setWarning(res.warning || null);
			toast({ title: 'Default domain updated', description: domain.domain, variant: 'success' });
			await qc.invalidateQueries({ queryKey: ['domains'] });
		},
	});
	return (
		<Section title="Infrastructure">
			{domain.is_default ? (
				<p className="flex items-start gap-2 text-sm">
					<Star aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-ink" />
					<span>
						<strong>This is the default domain.</strong> <span className="font-mono">reports.{domain.domain}</span> receives reports for all your domains.
					</span>
				</p>
			) : (
				<div className="space-y-2">
					<p className="text-sm text-ink-2">Make this the domain that hosts the reports address for all your domains.</p>
					<WriteButton variant="secondary" loading={setDefault.isPending} onClick={() => setDefault.mutate()}>
						Set as default domain
					</WriteButton>
				</div>
			)}
			{warning ? <Alert variant="warning" title="Check this">{warning}</Alert> : null}
			{setDefault.isError ? <Alert variant="danger" title="Could not set the default domain">{errorMessage(setDefault.error)}</Alert> : null}
		</Section>
	);
}

function DangerZone({ domain }: { domain: Domain }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const remove = useMutation({
		mutationFn: () => api(`/api/domains/${domain.id}`, { method: 'DELETE' }),
		onSuccess: async () => {
			toast({ title: 'Domain removed', description: domain.domain, variant: 'success' });
			setOpen(false);
			qc.removeQueries({ queryKey: domainKeys.all(domain.id) });
			await qc.invalidateQueries({ queryKey: ['domains'] });
			navigate('/');
		},
	});
	// 502: hosted DNS cleanup failed and the server kept the domain. Say so, and let the user try again.
	const cleanupFailed = remove.error instanceof ApiError && remove.error.status === 502;
	return (
		<Section title="Danger zone">
			<div className="space-y-3 rounded-lg border border-danger/40 p-4">
				<p className="text-sm text-ink-2">Removing a domain deletes all of its report data. This cannot be undone.</p>
				<WriteButton variant="danger" onClick={() => setOpen(true)}>
					Remove domain
				</WriteButton>
			</div>
			<ConfirmDialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) remove.reset();
				}}
				title={`Remove ${domain.domain}?`}
				description="All reports and statistics for this domain are deleted. DNS records you added stay where they are. This cannot be undone."
				confirmLabel={cleanupFailed ? 'Retry' : 'Yes, remove'}
				busyLabel="Removing…"
				variant="danger"
				busy={remove.isPending}
				error={remove.isError ? (cleanupFailed ? `${errorMessage(remove.error)} ${domain.domain} was NOT deleted. Nothing was removed, so you can retry.` : errorMessage(remove.error)) : null}
				onConfirm={() => remove.mutate()}
			/>
		</Section>
	);
}

function Settings({ domain }: { domain: Domain }) {
	return (
		<div className="max-w-3xl space-y-8">
			<PageHeader
				eyebrow={
					<Link to={`/domains/${domain.id}`} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
						<ArrowLeft aria-hidden className="size-4" />
						{domain.domain}
					</Link>
				}
				title="Settings"
				description={<span className="font-mono">{domain.domain}</span>}
			/>
			<ReadOnlyNotice />
			<Section title="Domain info">
				<Card>
					<CardContent className="space-y-4">
						<dl className="space-y-3">
							<Info label="Domain">{domain.domain}</Info>
							<Info label="Added">{domain.created_at ? formatDate(domain.created_at) : 'n/a'}</Info>
						</dl>
						<CopyField label="RUA address" value={`rua=mailto:${domain.rua_address}`} />
						<CopyField label="DMARC record" value={`v=DMARC1; p=${domain.dmarc_policy ?? 'none'}; rua=mailto:${domain.rua_address}`} />
					</CardContent>
				</Card>
			</Section>
			<ExportSection domain={domain} />
			<AlertsSection domain={domain} />
			<InfrastructureSection domain={domain} />
			<DangerZone domain={domain} />
		</div>
	);
}

export function DomainSettingsPage() {
	const id = useDomainId();
	const list = useDomains();
	const { domain } = useDomain(id);
	if (list.isPending) return <PageSkeleton label="Loading settings" />;
	if (list.isError) return <LoadError error={list.error} onRetry={() => void list.refetch()} title="Could not load this domain" />;
	if (!domain) {
		return (
			<EmptyState
				title="Domain not found"
				description="It may have been removed, or the link is wrong."
				action={
					<Button asChild>
						<Link to="/">Back to all domains</Link>
					</Button>
				}
			/>
		);
	}
	return <Settings domain={domain} />;
}
