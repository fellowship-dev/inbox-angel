import { Badge, Button, Card, CardContent, toast, type BadgeProps } from '@inbox-angel/ui';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { domainKeys, useMtaSts, useSpfFlatten } from '../../lib/domain-queries';
import type { MtaStsStatus, SpfFlatStatus } from '../../lib/types';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';
import { ConfirmDialog } from './ConfirmDialog';

interface ToolProps {
	domainId: number;
	title: string;
	badge: ReactNode;
	active: boolean;
	activeText: string;
	inactiveText: string;
	configureTo: string;
	disablePath: string;
	disableKey: readonly unknown[];
	disableTitle: string;
	disableDescription: string;
}

function ToolCard(p: ToolProps) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const disable = useMutation({
		mutationFn: () => api(p.disablePath, { method: 'DELETE' }),
		onSuccess: async () => {
			toast({ title: `${p.title} disabled`, variant: 'success' });
			setOpen(false);
			await qc.invalidateQueries({ queryKey: p.disableKey });
		},
	});
	return (
		<Card>
			<CardContent className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="font-semibold">{p.title}</h3>
					{p.badge}
				</div>
				<p className="text-sm text-ink-2">{p.active ? p.activeText : p.inactiveText}</p>
				<div className="flex flex-wrap gap-2">
					<Button asChild variant="secondary" size="sm">
						<Link to={p.configureTo}>Configure</Link>
					</Button>
					{p.active ? (
						<WriteButton variant="danger" size="sm" onClick={() => setOpen(true)}>
							Disable
						</WriteButton>
					) : null}
				</div>
			</CardContent>
			<ConfirmDialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) disable.reset();
				}}
				title={p.disableTitle}
				description={p.disableDescription}
				confirmLabel="Disable"
				busyLabel="Disabling…"
				variant="danger"
				busy={disable.isPending}
				error={disable.isError ? errorMessage(disable.error) : null}
				onConfirm={() => disable.mutate()}
			/>
		</Card>
	);
}

const activeBadge = (
	<Badge variant="success">
		<CheckCircle2 aria-hidden />
		Active
	</Badge>
);
const availableBadge = (
	<Badge variant="outline">
		<CircleDashed aria-hidden />
		Available
	</Badge>
);

function lookupBadge(count: number): { variant: BadgeProps['variant']; word: string; Icon: typeof CheckCircle2 } {
	if (count >= 10) return { variant: 'danger', word: 'over the limit', Icon: AlertTriangle };
	if (count >= 8) return { variant: 'warning', word: 'high', Icon: AlertTriangle };
	return { variant: 'success', word: 'ok', Icon: CheckCircle2 };
}

function spfCard(id: number, s: SpfFlatStatus) {
	const active = !!s.config?.enabled;
	const count = s.lookup_count ?? s.config?.lookup_count ?? null;
	let badge: ReactNode = availableBadge;
	if (active) badge = activeBadge;
	else if (count !== null) {
		const { variant, word, Icon } = lookupBadge(count);
		badge = (
			<Badge variant={variant}>
				<Icon aria-hidden />
				{count}/10 lookups ({word})
			</Badge>
		);
	}
	return (
		<ToolCard
			domainId={id}
			title="SPF flattening"
			badge={badge}
			active={active}
			activeText={`${s.config?.ip_count ?? '?'} IPs, re-resolved daily.`}
			inactiveText="Resolve SPF includes to raw IPs to stay under the 10-lookup limit."
			configureTo={`/domains/${id}/spf-flatten`}
			disablePath={`/api/domains/${id}/spf-flatten`}
			disableKey={domainKeys.spf(id)}
			disableTitle="Disable SPF flattening?"
			disableDescription="Inbox Angel restores your original SPF record and stops re-resolving it daily. Your lookup count may go back over the limit."
		/>
	);
}

function mtaCard(id: number, s: MtaStsStatus) {
	const active = !!s.config?.enabled;
	const mode = s.config?.mode ?? 'testing';
	return (
		<ToolCard
			domainId={id}
			title="MTA-STS"
			badge={
				active ? (
					<Badge variant={mode === 'enforce' ? 'success' : 'brand'}>
						<ShieldCheck aria-hidden />
						{mode}
					</Badge>
				) : (
					availableBadge
				)
			}
			active={active}
			activeText={`Requiring TLS for inbound mail (${mode} mode).`}
			inactiveText="Require TLS and collect failure reports for inbound mail."
			configureTo={`/domains/${id}/mta-sts`}
			disablePath={`/api/domains/${id}/mta-sts`}
			disableKey={domainKeys.mta(id)}
			disableTitle="Disable MTA-STS?"
			disableDescription="Senders stop being told to require TLS for your inbound mail, and the policy records are removed."
		/>
	);
}

function Slot<T>({ q, title, show, render }: { q: UseQueryResult<T>; title: string; show: (d: T) => boolean; render: (d: T) => ReactNode }) {
	if (q.isPending) return <ListSkeleton rows={1} label={`Loading ${title}`} />;
	if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} title={`Could not load ${title}`} />;
	return show(q.data) ? <>{render(q.data)}</> : null;
}

/** SPF flattening and MTA-STS: only shown when a tool is available or configured for this instance. */
export function DnsTools({ domainId }: { domainId: number }) {
	const spf = useSpfFlatten(domainId);
	const mta = useMtaSts(domainId);
	const spfHidden = spf.isSuccess && !spf.data.available && !spf.data.config;
	const mtaHidden = mta.isSuccess && !mta.data.available && !mta.data.config;
	if (spfHidden && mtaHidden) return null;
	return (
		<Section title="DNS tools" description="Optional tools that change your DNS for you.">
			<div className="grid gap-3 md:grid-cols-2">
				<Slot q={spf} title="SPF flattening" show={(d) => d.available || !!d.config} render={(d) => spfCard(domainId, d)} />
				<Slot q={mta} title="MTA-STS" show={(d) => d.available || !!d.config} render={(d) => mtaCard(domainId, d)} />
			</div>
		</Section>
	);
}
