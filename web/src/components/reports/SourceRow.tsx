import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@inbox-angel/ui';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Link } from 'react-router';
import { failLabel, isActive, isFailing } from '../../lib/reports';
import type { AnomalySource } from '../../lib/types';
import { ProviderName } from './ProviderName';

const mmdd = (day: string) => day.slice(5);

export function SourceStatus({ src, older }: { src: AnomalySource; older: boolean }) {
	if (!isFailing(src)) {
		return (
			<Badge variant="success">
				<CheckCircle2 aria-hidden />
				Passing
			</Badge>
		);
	}
	return (
		<span className="inline-flex flex-col items-start gap-1">
			<Badge variant="danger">
				<XCircle aria-hidden />
				{failLabel(src)} fail
			</Badge>
			{older ? <span className="text-xs text-ink-2">Not seen in 2+ days</span> : null}
		</span>
	);
}

/** One sending source. Failing sources not seen recently are dimmed (and say so in words). */
export function SourceRow({ src, domainId, older }: { src: AnomalySource; domainId: number; older: boolean }) {
	return (
		<TableRow className={cn(older && 'opacity-75')}>
			<TableCell className="max-w-64">
				<Link to={`/domains/${domainId}/reports/${src.last_seen}`} className="block rounded-sm text-brand-ink underline-offset-4 hover:underline">
					<ProviderName src={src} />
				</Link>
				{src.header_from ? <span className="mt-0.5 block text-xs text-ink-2">{src.header_from}</span> : null}
			</TableCell>
			<TableCell>
				<SourceStatus src={src} older={older} />
			</TableCell>
			<TableCell className="text-right tabular-nums">{src.total.toLocaleString()}</TableCell>
			<TableCell className="whitespace-nowrap tabular-nums">{mmdd(src.first_seen)}</TableCell>
			<TableCell className="whitespace-nowrap tabular-nums">{mmdd(src.last_seen)}</TableCell>
		</TableRow>
	);
}

/** Sources as a table that scrolls sideways on narrow screens (focusable region, labelled). */
export function SourceTable({ sources, domainId, label, now }: { sources: AnomalySource[]; domainId: number; label: string; now?: Date }) {
	return (
		<Table label={label}>
			<TableHeader>
				<TableRow>
					<TableHead>Source</TableHead>
					<TableHead>Status</TableHead>
					<TableHead className="text-right">Messages</TableHead>
					<TableHead>First seen</TableHead>
					<TableHead>Last seen</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{sources.map((s) => (
					<SourceRow key={`${s.source_ip}-${s.header_from}-${s.spf_domain}-${s.dkim_domain}`} src={s} domainId={domainId} older={isFailing(s) && !isActive(s.last_seen, now)} />
				))}
			</TableBody>
		</Table>
	);
}
