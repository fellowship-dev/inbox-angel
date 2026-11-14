import { Alert, Button, RecordBlock, StatusDot, type StatusDotStatus } from '@inbox-angel/ui';
import { RefreshCw } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../lib/api';
import { formatDateTime, timeAgo } from '../../lib/format';
import {
	useReportAddress,
	useReportAddressMutations,
	useReportIntakeEnabled,
	type OwnPlan,
	type ReportAddressPlan,
	type ReportAddressState,
	type ReportAddressView,
} from '../../lib/report-address';
import { CopyField } from '../domain/CopyField';
import { ConfirmDialog } from '../domain/ConfirmDialog';
import { RadioCard } from '../wizard/RadioCard';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';

/**
 * Hosted only: connect a domain's DMARC reports. One action connects the domain to the hosted report address, then the
 * panel shows exactly what to publish (the live DMARC record with the address added, never a weaker policy) and how far
 * it has got from live DNS and stored reports: connected, published, receiving. Renders nothing, and requests nothing, unless this deployment takes hosted reports
 * (GET /api/hosted/config `reports: true`), so self-hosted instances are unchanged.
 *
 * Integration: `<ConnectReports domain={domain} />` anywhere a domain is known (`{ id, domain }`). `bare` is for a
 * container that already says reports are not connected (ReportsNotConnected, a wizard step): no section heading, and
 * before reports are connected only the action itself.
 */
export function ConnectReports({ domain, bare = false }: { domain: { id: number; domain: string }; bare?: boolean }) {
	const enabled = useReportIntakeEnabled();
	if (!enabled) return null;
	const body = <Panel domainId={domain.id} domainName={domain.domain} bare={bare} />;
	return bare ? (
		<div data-testid="connect-reports">{body}</div>
	) : (
		<div data-testid="connect-reports">
			<Section title="DMARC reports">{body}</Section>
		</div>
	);
}

const STATE_DOT: Record<ReportAddressState, { status: StatusDotStatus; label: string }> = {
	not_connected: { status: 'unknown', label: 'Reports not connected yet' },
	not_published: { status: 'warn', label: 'Connected, record not published yet' },
	waiting: { status: 'info', label: 'Published, waiting for the first report' },
	receiving: { status: 'ok', label: 'Receiving reports' },
	unknown: { status: 'unknown', label: 'Connected, DNS check failed' },
};

function Panel({ domainId, domainName, bare }: { domainId: number; domainName: string; bare: boolean }) {
	const q = useReportAddress(domainId);
	const m = useReportAddressMutations(domainId);
	const [disconnectOpen, setDisconnectOpen] = useState(false);

	if (q.isPending) return <ListSkeleton rows={1} label="Loading the report address" />;
	if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load the report address" />;
	const s = q.data;
	if (!s.available) return null;

	if (s.managed_by === 'hosted_records') {
		return <p className="text-sm text-ink-2">Reports for {domainName} come through its hosted records.</p>;
	}

	if (!s.address) {
		return (
			<div className={bare ? 'space-y-3' : 'space-y-3 rounded-lg border border-line bg-surface-1 p-4'} data-state="not_connected">
				{bare ? null : (
					<>
						<StatusDot status={STATE_DOT.not_connected.status} label={STATE_DOT.not_connected.label} className="font-semibold" />
						<p className="text-sm text-ink-2">
							Mail servers send DMARC reports to the addresses listed in a domain&apos;s DMARC record. Connect reports to have the reports for{' '}
							<Mono>{domainName}</Mono> filed here; you then see the exact record to publish.
						</p>
					</>
				)}
				{s.can_connect ? (
					<WriteButton onClick={() => m.connect.mutate()} disabled={m.connect.isPending} reasonVisible>
						{m.connect.isPending ? 'Connecting…' : 'Connect reports'}
					</WriteButton>
				) : (
					<p className="text-sm text-ink-2">{s.refusal}</p>
				)}
				{m.connect.isError ? (
					<Alert variant="danger" title="Could not connect reports">
						{errorMessage(m.connect.error)}
					</Alert>
				) : null}
			</div>
		);
	}

	const disconnectErr = m.disconnect.isError ? errorMessage(m.disconnect.error) : null;
	return (
		<div className="space-y-4 rounded-lg border border-line bg-surface-1 p-4" data-state={s.state}>
			<StateLine s={s} />
			<CopyField label="Report address" value={s.address} />
			{s.dns?.plan ? <PlanView plan={s.dns.plan} domain={domainName} parent={s.parent ?? null} /> : null}
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
					<RefreshCw aria-hidden />
					{q.isFetching ? 'Checking…' : 'Check again'}
				</Button>
				<WriteButton variant="danger" size="sm" onClick={() => setDisconnectOpen(true)}>
					Disconnect reports
				</WriteButton>
			</div>
			<ConfirmDialog
				open={disconnectOpen}
				onOpenChange={(o) => {
					setDisconnectOpen(o);
					if (!o) m.disconnect.reset();
				}}
				title={`Disconnect reports for ${domainName}?`}
				description={`From now on, reports about ${domainName} are refused. Reports already received stay. Remove the address from your DMARC record too.`}
				confirmLabel="Disconnect reports"
				busyLabel="Disconnecting…"
				variant="danger"
				busy={m.disconnect.isPending}
				error={disconnectErr}
				onConfirm={() => m.disconnect.mutate(undefined, { onSuccess: () => setDisconnectOpen(false) })}
			/>
		</div>
	);
}

function StateLine({ s }: { s: ReportAddressView }) {
	const dot = STATE_DOT[s.state];
	let detail: ReactNode = null;
	if (s.state === 'not_published') {
		detail = <>Checked in live DNS {s.dns ? timeAgo(s.dns.checked_at) : 'just now'}: the DMARC record does not list the report address yet. Publish the record below.</>;
	} else if (s.state === 'waiting') {
		detail = <>Your DMARC record lists the report address. Receivers send reports about once a day, so the first one can take a day or two.</>;
	} else if (s.state === 'receiving' && s.last_report_at) {
		detail = (
			<>
				Last report received {formatDateTime(s.last_report_at)} ({timeAgo(s.last_report_at)}). <Link to={`/domains/${s.domain_id}/reports`}>Open the reports</Link>
			</>
		);
	} else if (s.state === 'unknown') {
		detail = <>We could not read the DMARC record just now, so we cannot say whether it lists the report address. The lookup failed; that does not mean the record is missing.</>;
	}
	return (
		<div className="space-y-1">
			<StatusDot status={dot.status} label={dot.label} className="font-semibold" />
			{detail ? <p className="text-sm text-ink-2">{detail}</p> : null}
		</div>
	);
}

const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">{children}</code>;

function PlanView({ plan, domain, parent }: { plan: ReportAddressPlan; domain: string; parent: ReportAddressView['parent'] }) {
	if (plan.kind === 'published') return null;
	if (plan.kind === 'multiple') {
		return (
			<Alert variant="warning" title={`${plan.name} has ${plan.records.length} DMARC records`}>
				<p>Receivers ignore all of them when there is more than one. Keep one, then add the report address to its rua= tag.</p>
				<ul className="mt-2 space-y-1">
					{plan.records.map((r) => (
						<li key={r}>
							<Mono>{r}</Mono>
						</li>
					))}
				</ul>
			</Alert>
		);
	}
	if (plan.kind === 'inherited') {
		return (
			<div className="space-y-3">
				<p className="text-sm text-ink-2">
					<Mono>{domain}</Mono> has no DMARC record of its own. It follows the record of <Mono>{plan.from}</Mono> (policy for subdomains: p={plan.policy}), and receivers send
					its reports to the addresses listed there.
				</p>
				{plan.parent_has_address ? (
					<Alert variant="warning" title={`${plan.from} lists this address`}>
						Reports sent from that record are about {plan.from}, and this address only accepts reports about {domain}. They are refused. Connect reports on {plan.from}{' '}
						instead, or publish the record below.
					</Alert>
				) : null}
				<p className="text-sm text-ink-2">
					{parent?.connected ? (
						<>
							<Link to={`/domains/${parent.domain_id}`}>{plan.from}</Link> is connected here, so once its record lists the report address, reports about {domain} arrive
							with its reports.
						</>
					) : parent ? (
						<>
							To keep following {plan.from}, connect reports on <Link to={`/domains/${parent.domain_id}`}>{plan.from}</Link> instead. Reports about {domain} then arrive with
							its reports.
						</>
					) : (
						<>
							To keep following {plan.from}, add {plan.from} to this workspace and connect reports there instead. Reports about {domain} then arrive with its reports.
						</>
					)}
				</p>
				<p className="text-sm text-ink-2">
					Or give {domain} a record of its own. It keeps the policy it has now (p={plan.policy}) and the addresses {plan.from} lists, but later changes to {plan.from}
					&apos;s record no longer apply to it.
				</p>
				<OwnPlanView plan={plan.own} domain={domain} inherited />
			</div>
		);
	}
	return <OwnPlanView plan={plan} domain={domain} />;
}

function Current({ record }: { record: string }) {
	return (
		<p className="text-sm text-ink-2">
			Published now: <Mono>{record}</Mono>
		</p>
	);
}

function OwnPlanView({ plan, domain, inherited = false }: { plan: OwnPlan; domain: string; inherited?: boolean }) {
	if (plan.kind === 'published') return null;
	if (plan.kind === 'add') {
		return (
			<div className="space-y-2">
				{plan.current ? <Current record={plan.current} /> : null}
				<RecordBlock
					title={plan.current ? `Replace the TXT record at ${plan.name} with` : `Add this TXT record at your DNS provider`}
					record={{ type: 'TXT', name: plan.name, value: plan.record }}
				/>
				<p className="text-sm text-ink-2">
					{plan.current
						? 'Only rua= changes: the policy and every other tag stay as they are.'
						: inherited
							? 'Every tag and the policy stay as they apply today; only the rua= list gains this address.'
							: `${domain} has no DMARC record. p=none asks receivers for reports and changes nothing about how they handle your mail.`}
				</p>
			</div>
		);
	}
	return <ChooseView plan={plan} />;
}

function ChooseView({ plan }: { plan: Extract<OwnPlan, { kind: 'choose' }> }) {
	const [choice, setChoice] = useState<string | null>(null);
	const name = useId();
	const legend = useId();
	const THIRD = '__third__';
	const picked = choice === null ? null : plan.options.find((o) => (o.replaces ?? THIRD) === choice) ?? null;
	return (
		<div className="space-y-3">
			{plan.current ? <Current record={plan.current} /> : null}
			<fieldset className="space-y-2" aria-labelledby={legend}>
				<p id={legend} className="text-sm text-ink-2">
					{plan.current ? (
						<>
							The record at <Mono>{plan.name}</Mono> already lists {plan.existing.length} report addresses.
						</>
					) : (
						<>This record starts with the {plan.existing.length} report addresses listed today.</>
					)}{' '}
					Receivers only have to send to two, so choose which one this address replaces. Nothing changes until you publish the record.
				</p>
				{plan.options.map((o) => {
					const value = o.replaces ?? THIRD;
					return (
						<RadioCard
							key={value}
							name={name}
							value={value}
							checked={choice === value}
							onChange={setChoice}
							title={o.replaces ? <span className="[overflow-wrap:anywhere]">Replace {o.replaces}</span> : 'Keep both and add this address third'}
						>
							{o.replaces ? 'That address stops getting reports from this record.' : 'Some receivers may never send reports to a third address.'}
						</RadioCard>
					);
				})}
			</fieldset>
			{picked ? (
				<RecordBlock
					title={plan.current ? `Replace the TXT record at ${plan.name} with` : 'Add this TXT record at your DNS provider'}
					record={{ type: 'TXT', name: plan.name, value: picked.record }}
				/>
			) : (
				<p className="text-sm text-ink-2">Choose an option to see the record to publish.</p>
			)}
		</div>
	);
}
