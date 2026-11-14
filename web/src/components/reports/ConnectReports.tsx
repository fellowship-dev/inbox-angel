import { Alert, Button, RecordBlock, StatusDot, type StatusDotStatus } from '@ready-set-mail/ui';
import { RefreshCw } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../lib/api';
import { countingBasisNote, emptyReportsState, storageDropNotices, uncountedNotice, uncountedReporters } from '../../lib/uncounted';
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
import { inheritedCoverage, keptEnforcement, offerEnforcement, recordFor } from '../../lib/dmarc-coverage';
import { parseDmarcTags } from '../../lib/dmarc-record';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';

/**
 * Hosted only: connect a domain's DMARC reports. One action connects the domain to the hosted report address, then the
 * panel shows exactly what to publish (the live DMARC record with the address added, never a weaker policy) and how far
 * it has got from live DNS and stored reports: connected, published, receiving. Renders nothing, and requests nothing, unless this deployment takes hosted reports
 * (GET /api/hosted/config `reports: true`), so self-hosted instances are unchanged.
 *
 * Integration: `<ConnectReports domain={domain} />` anywhere a domain is known (`{ id, domain }`). `bare` is for a
 * container that already says reports are not connected (ReportsNotConnected): no section heading, and before reports
 * are connected only the action itself. `headless` drops only the section heading (a wizard step that has its own).
 */
export function ConnectReports({ domain, bare = false, headless = false }: { domain: { id: number; domain: string }; bare?: boolean; headless?: boolean }) {
	const enabled = useReportIntakeEnabled();
	if (!enabled) return null;
	const body = <Panel domainId={domain.id} domainName={domain.domain} bare={bare} />;
	return bare || headless ? (
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
	receiving: { status: 'ok', label: 'Reports received' },
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
			{s.dns?.plan ? <PlanView plan={s.dns.plan} domain={domainName} parent={s.parent ?? null} address={s.address} /> : null}
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
				Last counted report received {formatDateTime(s.last_report_at)} ({timeAgo(s.last_report_at)}). <Link to={`/domains/${s.domain_id}/reports`}>Open the reports</Link>
			</>
		);
	} else if (s.state === 'unknown') {
		detail = <>We could not read the DMARC record just now, so we cannot say whether it lists the report address. The lookup failed; that does not mean the record is missing.</>;
	}
	const plural = (n: number) => (n === 1 ? '1 report' : `${n} reports`);
	// What else is true about the reports since connecting, in the dashboard's shared words (web/src/lib/uncounted.ts): reports from
	// senders we do not recognise are not counted, counted reports dropped for want of storage, and mail that could not be processed.
	const v = s.visibility ?? null;
	const empty = s.state === 'receiving' ? 'counted' : emptyReportsState(s.counted_since_connect, v);
	const notes = [
		...storageDropNotices(v),
		uncountedNotice(v),
		uncountedReporters(v),
		empty === 'not_processed' || empty === 'limited' ? v?.intake?.notice ?? null : null,
		empty === 'blocked' ? v?.counting_note ?? null : null,
	].filter((x): x is string => !!x);
	const basis = countingBasisNote(v?.report_counting);
	return (
		<div className="space-y-1">
			<StatusDot status={dot.status} label={dot.label} className="font-semibold" />
			{detail ? <p className="text-sm text-ink-2">{detail}</p> : null}
			{notes.map((n) => (
				<p key={n} className="text-sm text-ink-2" data-testid="reports-notice">
					{n}
				</p>
			))}
			{s.reports_before_connect > 0 ? <p className="text-sm text-ink-2">{plural(s.reports_before_connect)} received before this connection.</p> : null}
			{basis && s.state !== 'not_connected' ? <p className="text-xs text-ink-2">{basis}</p> : null}
		</div>
	);
}

const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">{children}</code>;

function PlanView({ plan, domain, parent, address }: { plan: ReportAddressPlan; domain: string; parent: ReportAddressView['parent']; address: string }) {
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
	if (plan.kind === 'invalid') {
		return (
			<Alert variant="warning" title={`The DMARC record at ${plan.name} is not valid`}>
				<p>
					{plan.issues.join('. ')}. Receivers apply no policy from it. Fix it first, then check again to see the record to publish.
				</p>
				<p className="mt-2">
					<Mono>{plan.record}</Mono>
				</p>
			</Alert>
		);
	}
	if (plan.kind === 'inherited') {
		const parentLink = parent ? <Link to={`/domains/${parent.domain_id}`}>{plan.from}</Link> : <>{plan.from}</>;
		return (
			<div className="space-y-3">
				<p className="text-sm text-ink-2">
					<Mono>{domain}</Mono> has no DMARC record of its own. It follows the record of <Mono>{plan.from}</Mono>, where{' '}
					{plan.policy_tag === 'sp' ? <>sp={plan.policy} applies to its subdomains</> : <>p={plan.policy} applies to it and its subdomains</>}, and receivers send its reports to
					the addresses listed there.
				</p>
				<p className="text-sm text-ink-2" data-testid="inherited-route">
					{plan.parent_has_address ? (
						parent?.connected ? (
							<>{parentLink}&apos;s record lists the report address and {plan.from} is connected here, so reports about {domain} are filed with {plan.from}&apos;s reports.</>
						) : parent ? (
							<>{parentLink}&apos;s record lists the report address, but {plan.from} is not connected in this workspace, so those reports are refused. Connect reports on {parentLink} to receive them, including those about {domain}.</>
						) : (
							<>{plan.from}&apos;s record lists the report address, but {plan.from} is not in this workspace, so its reports, including those about {domain}, are not filed here. Add {plan.from} to this workspace and connect reports there to receive them.</>
						)
					) : parent?.connected ? (
						<>{parentLink} is connected here, so once its record lists the report address, reports about {domain} arrive with its reports.</>
					) : parent ? (
						<>To keep following {plan.from}, connect reports on {parentLink} instead. Reports about {domain} then arrive with its reports.</>
					) : (
						<>To keep following {plan.from}, add {plan.from} to this workspace and connect reports there instead. Reports about {domain} then arrive with its reports.</>
					)}
				</p>
				<InheritedOwnRecord plan={plan} domain={domain} address={address} />
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
				<RecordToPublish replace={!!plan.current} name={plan.name} value={plan.record} />
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
				<RecordToPublish replace={!!plan.current} name={plan.name} value={picked.record} />
			) : (
				<p className="text-sm text-ink-2">Choose an option to see the record to publish.</p>
			)}
		</div>
	);
}

/** A TXT string holds at most 255 characters; a longer record is published as several quoted strings in one record. */
export function txtStrings(value: string): string {
	const parts: string[] = [];
	for (let i = 0; i < value.length; i += 255) parts.push(`"${value.slice(i, i + 255)}"`);
	return parts.join(' ');
}

function RecordToPublish({ replace, name, value }: { replace: boolean; name: string; value: string }) {
	const long = value.length > 255;
	return (
		<div className="space-y-2">
			<RecordBlock
				title={replace ? `Replace the TXT record at ${name} with` : 'Add this TXT record at your DNS provider'}
				record={{ type: 'TXT', name, value: long ? txtStrings(value) : value }}
			/>
			{long ? (
				<p className="text-sm text-ink-2">
					This record is longer than 255 characters, so it must be entered as the quoted strings shown, one after another in the same TXT record.
				</p>
			) : null}
		</div>
	);
}

/**
 * A record of the subdomain's own, built by the same rule as every other offered record (offerEnforcement + recordFor):
 * exactly the enforcement in force, inherited pct= and alignment included, never weaker or stricter.
 */
function InheritedOwnRecord({ plan, domain, address }: { plan: Extract<ReportAddressPlan, { kind: 'inherited' }>; domain: string; address: string }) {
	const coverage = inheritedCoverage(plan.from, plan.parent_record, plan.policy);
	const e = offerEnforcement(coverage);
	if (!e) return null;
	const align = [e.adkim ? `adkim=${e.adkim}` : null, e.aspf ? `aspf=${e.aspf}` : null].filter(Boolean).join(', ');
	// Failure reports (RFC 7489 ruf= and its fo= options) are not part of the enforcement in force: a record of its own does not carry them.
	const tags = parseDmarcTags(plan.parent_record);
	const failureTags = (['ruf', 'fo'] as const).filter((t) => tags[t] !== undefined);
	return (
		<div className="space-y-2">
			<p className="text-sm text-ink-2">
				Or give {domain} a record of its own. It keeps {keptEnforcement(coverage, e)}
				{align ? ` with ${align}` : ''}, so nothing changes for its mail, and its reports go only to the report address. Later changes to {plan.from}&apos;s record no
				longer apply to it.
				{failureTags.length ? (
					<>
						{' '}
						{plan.from}&apos;s failure-report settings ({failureTags.map((t) => `${t}=`).join(', ')}) are not carried over: no failure reports are requested for {domain}.
					</>
				) : null}
			</p>
			<RecordToPublish replace={false} name={plan.own.name} value={recordFor(e, address)} />
		</div>
	);
}
