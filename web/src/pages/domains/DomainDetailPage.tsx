import { HealthReportSection, useHealthReport } from './HealthReportSection';
import { Alert, Badge, Button, EmptyState, LevelLadder, PageHeader, Skeleton, StatusLabel, Tabs, TabsList, TabsTrigger } from '@ready-set-mail/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, Settings } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useDomainId } from '../../app';
import { DailyChart } from '../../components/domain/DailyChart';
import { CopyField } from '../../components/domain/CopyField';
import { DnsRecords } from '../../components/domain/DnsRecords';
import { DnsTools } from '../../components/domain/DnsTools';
import { DoThisNext } from '../../components/domain/DoThisNext';
import { FailingSources } from '../../components/domain/FailingSources';
import { HostedPanel } from '../../components/hosted/HostedPanel';
import { Rollout } from '../../components/domain/Rollout';
import { ReportsNotConnected, useReportsNotConnected } from '../../components/ReportsNotConnected';
import { Disclosure, ListSkeleton, LoadError, PageSkeleton, ReadOnlyNotice, Section } from '../../components/states';
import { actionsPending, domainActions } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { useHostedInfo } from '../../lib/hosted';
import { domainVerdict, totalsFromSummary, unavailableVerdict, type ReportTotals } from '../../lib/verdict';
import { invalidDmarcSp } from '../../lib/dmarc-record';
import { getGuidance, spTag, sumStats, wizardProgress, type GuidanceTone } from '../../lib/dmarc';
import { domainKeys, useCheckSummary, useDnsCheck, useFailingSources, useMtaSts, useOnboardingStatus, useRolloutNext, useSpfFlatten, useStats, useWizardState } from '../../lib/domain-queries';
import { formatNumber } from '../../lib/format';
import { useDomain, useDomains } from '../../lib/queries';
import { hasReportAddress } from '../../lib/dmarc-record';
import { useHosted, useSession } from '../../lib/session';
import type { Domain } from '../../lib/types';

const WINDOWS = [7, 30, 60] as const;
const ALERT_VARIANT: Record<GuidanceTone, 'info' | 'success' | 'warning' | 'danger'> = { neutral: 'info', info: 'info', success: 'success', warning: 'warning', danger: 'danger' };

const policyLabel = (p: Domain['dmarc_policy']) => p ?? 'none';

function PolicyBadge({ policy }: { policy: Domain['dmarc_policy'] }) {
	const variant = policy === 'reject' ? 'success' : policy === 'quarantine' ? 'warning' : 'danger';
	return <Badge variant={variant}>p={policyLabel(policy)}</Badge>;
}

/**
 * The policy as the DNS shows it now, from the same read as the DMARC record card (one query, so the two can
 * never disagree). When DNS has no record the stored policy is only a "last known" value, and says so.
 */
function LivePolicyBadge({ domain }: { domain: Domain }) {
	const dns = useDnsCheck(domain.id);
	const onboarding = useOnboardingStatus(domain.id); // same query as the DNS records card: nxdomain and the inherited policy
	if (dns.isPending) return <Badge variant="outline">Checking DMARC policy…</Badge>;
	if (onboarding.data?.nxdomain) return <Badge variant="outline">Does not resolve</Badge>;
	const lastKnown = domain.dmarc_policy && domain.dmarc_policy !== 'none' ? ` (last known policy: p=${domain.dmarc_policy})` : '';
	if (dns.isError || dns.data.error) return <Badge variant="outline">DMARC lookup failed{lastKnown}</Badge>;
	const inherited = onboarding.data?.dmarc.effective;
	if ((!dns.data.found || !dns.data.current_record) && inherited?.inherited_from && inherited.policy) {
		return <Badge variant="outline">No record of its own: inherits p={inherited.policy} from {inherited.inherited_from}</Badge>;
	}
	if (!dns.data.found || !dns.data.current_record) return <Badge variant="outline">No DMARC record found{lastKnown}</Badge>;
	const live = dns.data.current_record.match(/(^|;\s*)p=([a-z]+)/i)?.[2]?.toLowerCase();
	return live ? <PolicyBadge policy={live as Domain['dmarc_policy']} /> : <Badge variant="outline">DMARC record has no p= tag</Badge>;
}

function Context({ domain, all }: { domain: Domain; all: Domain[] }) {
	const dns = useDnsCheck(domain.id);
	const parent = domain.parent_id ? all.find((d) => d.id === domain.parent_id) : undefined;
	const children = all.filter((d) => d.parent_id === domain.id);
	if (!parent && children.length === 0) return null;
	const record = dns.data?.current_record ?? null;
	const sp = spTag(record);
	const badSp = invalidDmarcSp(record);
	const ownRecord = !!dns.data && !dns.data.error && dns.data.found;
	const lookupFailed = dns.isError || !!dns.data?.error;
	return (
		<div className="space-y-6">
			{parent ? (
				<Alert variant="info" title={ownRecord ? 'Has its own DMARC record' : lookupFailed ? 'Parent domain' : 'Inherits DMARC from its parent'}>
					{ownRecord ? (
						<>
							p={policyLabel(domain.dmarc_policy)} overrides the parent <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>.
						</>
					) : lookupFailed ? (
						<>
							Subdomain of <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>. We could not check whether it has its own DMARC record.
						</>
					) : (
						<>
							Inherits DMARC from <Link to={`/domains/${parent.id}`}>{parent.domain}</Link>
							{parent.dmarc_policy ? ` (p=${parent.dmarc_policy})` : ''}. SPF and DKIM are independent and not inherited.
						</>
					)}
				</Alert>
			) : null}
			{children.length > 0 ? (
				<Section
					title="Subdomains"
					actions={
						<Link className="text-sm text-brand-ink underline underline-offset-4" to="/add">
							Add subdomain
						</Link>
					}
				>
					{sp === 'reject' ? (
						<Alert variant="success" title="sp=reject">
							All subdomains without their own record are protected.
						</Alert>
					) : badSp ? (
						<Alert variant="warning" title="sp= is not a valid policy">
							The record has sp={badSp}, which is not none, quarantine or reject, so it is ignored: subdomains without their own record inherit p={policyLabel(domain.dmarc_policy)}.
						</Alert>
					) : sp ? (
						<Alert variant="warning" title={`sp=${sp}: not enforced`}>
							Subdomains without their own DMARC record are NOT enforced. Consider adding sp=reject.
						</Alert>
					) : record ? (
						<Alert variant="warning" title="No sp= tag">
							Subdomains without their own record inherit p={policyLabel(domain.dmarc_policy)}, which may be too permissive.
						</Alert>
					) : null}
					<ul className="divide-y divide-line rounded-lg border border-line bg-surface-1">
						{children.map((c) => (
							<li key={c.id}>
								<Link to={`/domains/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
									<span className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">{c.domain}</span>
									<PolicyBadge policy={c.dmarc_policy} />
								</Link>
							</li>
						))}
					</ul>
				</Section>
			) : null}
		</div>
	);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the domain stands: the level ladder, the state, what is true now and its evidence, and setup progress. */
function WhereItStands({ domain }: { domain: Domain }) {
	const summary = useCheckSummary(domain.id);
	const hosted = useHostedInfo(domain.id);
	const wizard = useWizardState(domain.id);
	const { canWrite } = useSession();
	const hostedMode = useHosted();
	const headingId = useId();
	// The same summary and 30-day totals the overview reads, so both pages say the same thing.
	const v = summary.isError ? unavailableVerdict(errorMessage(summary.error), domain.domain) : summary.data ? domainVerdict(domain, summary.data, totalsFromSummary(summary.data), hosted, undefined, { hostedMode }) : null;
	const progress = canWrite && wizard.data ? wizardProgress(wizard.data, { hosted: hostedMode }) : null;
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h2 id={headingId} className="text-lg font-semibold tracking-tight">
				Where it stands
			</h2>
			<div className="grid gap-x-6 gap-y-4 rounded-lg border border-line bg-surface-1 p-4 sm:p-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
				{v ? <LevelLadder level={v.level} className="self-start lg:pt-1" /> : <Skeleton className="h-8 w-full" />}
				<div className="min-w-0 space-y-1.5">
					{v ? (
						<>
							<StatusLabel kind={v.status} />
							<p className="max-w-prose text-sm text-ink-1">{v.sentence}</p>
							{v.evidence ? <p className="max-w-prose text-sm text-ink-2">{v.evidence}</p> : null}
							{v.checked ? <p className="text-xs text-ink-2">{v.checked}</p> : null}
							{summary.isError ? (
								<Button variant="secondary" size="sm" onClick={() => void summary.refetch()}>
									Try again
								</Button>
							) : null}
						</>
					) : (
						<p className="text-sm text-ink-2">Loading what is known about this domain…</p>
					)}
					{/* Only while DNS shows the domain is not yet enforcing: an enforced domain's setup is done, whatever the wizard recorded. */}
					{progress && progress.done < progress.total && v && (v.level === 0 || v.level === 1) ? (
						<p className="pt-1 text-sm text-ink-2">
							Setup wizard: {progress.done} of {progress.total} steps done.{' '}
							<Link to={`/domains/${domain.id}/setup/${progress.nextStep}`} className="font-medium text-brand-ink underline underline-offset-4">
								Continue setup
							</Link>
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}

function DomainDetail({ domain, all }: { domain: Domain; all: Domain[] }) {
	const qc = useQueryClient();
	const [days, setDays] = useState<number>(7);
	const stats = useStats(domain.id, days);
	const week = useStats(domain.id, 7);
	const sources = useFailingSources(domain.id);
	const dns = useDnsCheck(domain.id);
	const onboarding = useOnboardingStatus(domain.id);
	const summary = useCheckSummary(domain.id);
	const rollout = useRolloutNext(domain.id);
	// The health report runs live DNS and reads collected evidence: only when its section is opened.
	const [healthOpen, setHealthOpen] = useState(false);
	const health = useHealthReport(domain.id, healthOpen);
	const spfTool = useSpfFlatten(domain.id);
	const mtaTool = useMtaSts(domain.id);
	const { canWrite } = useSession();
	// Hosted, before report intake: no reports can arrive (see ReportsNotConnected).
	const reportsOff = useReportsNotConnected(domain);
	const nxdomain = !!onboarding.data?.nxdomain;

	// Reading DNS here also stores what it found (the overview's "checked when"), so refresh the stored summary after it.
	const readAt = onboarding.dataUpdatedAt;
	useEffect(() => {
		if (readAt) void qc.invalidateQueries({ queryKey: domainKeys.summary(domain.id) });
	}, [readAt, qc, domain.id]);

	const totals = (q: typeof week, n: number): ReportTotals | null | undefined => {
		if (q.isPending) return undefined;
		if (q.isError) return null;
		const s = sumStats(q.data.stats);
		return { total: s.total, passed: s.passed, failed: s.failed, passRate: s.passRate, days: n };
	};
	const week7 = totals(week, 7);
	const actionInput = {
		domain,
		dns: dns.isPending ? undefined : dns.isError ? null : dns.data,
		onboarding: onboarding.isPending ? undefined : onboarding.isError ? null : onboarding.data,
		summary: summary.data ?? (summary.isError ? null : undefined),
		reports: week7,
		sources: sources.data ?? null,
	};
	const actions = domainActions(actionInput);

	const sums = stats.data ? sumStats(stats.data.stats) : null;
	const guidance = sums ? getGuidance(domain, sums.passRate, sums.total > 0, dns.data && !dns.data.error && dns.data.found ? dns.data.current_record : null) : null;

	const parent = domain.parent_id ? all.find((d) => d.id === domain.parent_id) : undefined;
	const children = all.filter((d) => d.parent_id === domain.id);
	const selectors = onboarding.data?.dkim.selectors.length;
	const enforcing = rollout.data && (rollout.data.current_policy === 'quarantine' || rollout.data.current_policy === 'reject');
	const toolsShown = !(spfTool.isSuccess && !spfTool.data.available && !spfTool.data.config && mtaTool.isSuccess && !mtaTool.data.available && !mtaTool.data.config);
	const failing = sources.data?.length ?? 0;

	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={
					<Link to="/" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
						<ArrowLeft aria-hidden className="size-4" />
						All domains
					</Link>
				}
				title={domain.domain}
				description={<LivePolicyBadge domain={domain} />}
				actions={
					<div className="flex flex-wrap gap-2">
						<Button asChild variant="secondary">
							<Link to={`/domains/${domain.id}/analytics`}>
								<BarChart3 aria-hidden />
								Analytics
							</Link>
						</Button>
						<Button asChild variant="secondary">
							<Link to={`/domains/${domain.id}/settings`}>
								<Settings aria-hidden />
								Settings
							</Link>
						</Button>
					</div>
				}
			/>
			<ReadOnlyNotice />
			<DoThisNext
				actions={actions}
				pending={actionsPending(actionInput)}
				canWrite={canWrite}
				onRetry={() => void Promise.all([dns.refetch(), onboarding.refetch()])}
			/>
			<WhereItStands domain={domain} />

			{/* A name that does not resolve has nothing to host. */}
			{nxdomain ? null : <HostedPanel key={domain.id} domainId={domain.id} />}

			<div className="space-y-3">
				<Disclosure
					id="dns-records"
					title="DNS records"
					summary={`DMARC, SPF${selectors === undefined ? ' and DKIM' : onboarding.data?.dkim.wildcard ? ', and DKIM that public DNS can\'t show (wildcard)' : selectors === 0 ? ', and no DKIM key among the common selectors' : ` and ${plural(selectors, 'DKIM key')}`}, read live from public DNS.`}
				>
					<DnsRecords domain={domain} />
				</Disclosure>

				{/* Hosted, before report intake: no reports can arrive, so the report sections say so once instead of showing zeros. */}
				{reportsOff ? (
					<ReportsNotConnected domain={domain.domain} />
				) : (
				<Disclosure
						title="Reports"
						summary={
							week.isPending
								? 'Loading report totals…'
								: week.isError
									? 'Report totals could not be loaded.'
									: week7 && week7.total > 0
										? `${week7.passRate}% of ${formatNumber(week7.total)} reported messages passed DMARC in the last 7 days.`
										: 'No reports in the last 7 days.'
						}
					>
						<div className="space-y-6">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<p className="text-sm text-ink-1">
									{stats.isPending
										? 'Loading…'
										: stats.isError
											? null
											: sums && sums.total > 0
												? `Last ${days} days: ${sums.passRate}% passed. ${formatNumber(sums.passed)} of ${formatNumber(sums.total)} messages passed, ${formatNumber(sums.failed)} failed.`
												: `No reports in the last ${days} days.`}
								</p>
								<Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
									<TabsList aria-label="Time window">
										{WINDOWS.map((w) => (
											<TabsTrigger key={w} value={String(w)}>
												{w}d<span className="sr-only"> window</span>
											</TabsTrigger>
										))}
									</TabsList>
								</Tabs>
							</div>
							{stats.isError ? <LoadError error={stats.error} onRetry={() => void stats.refetch()} title="Could not load results" /> : null}
							{guidance ? (
								<Alert variant={ALERT_VARIANT[guidance.tone]} title={guidance.title}>
									<p>{guidance.body}</p>
									{guidance.upgradeTo && canWrite ? (
										<Button asChild size="sm" variant="secondary" className="mt-3">
											<Link to={`/domains/${domain.id}/dmarc-wizard`}>Upgrade to {guidance.upgradeTo}</Link>
										</Button>
									) : null}
									{sums?.total === 0 && dns.data ? (
										<p className="mt-2">
											{dns.data.error
												? 'We could not check your DNS record just now. See DNS records above.'
												: dns.data.found && dns.data.has_rua
													? 'DNS record detected. Reports will start arriving soon.'
													: dns.data.found
														? hasReportAddress(domain.rua_address)
															? 'A DMARC record is published, but it does not send reports to your reports address yet. See DNS records above.'
															: 'A DMARC record is published. No reports address is configured for this domain, so no reports can arrive here yet.'
														: 'DNS record not found yet. Make sure you have added it, then wait a few minutes for propagation.'}
										</p>
									) : null}
								</Alert>
							) : null}
							{stats.isPending ? <ListSkeleton rows={1} label="Loading daily results" /> : stats.isError ? null : <DailyChart domainId={domain.id} stats={stats.data.stats} days={days} />}
							<div className="space-y-2">
								<p className="text-sm font-semibold text-ink-1">Reporting address</p>
								{hasReportAddress(domain.rua_address) ? (
									<>
										<p className="text-sm text-ink-2">
											Add this to your <code>_dmarc.{domain.domain}</code> TXT record so receiving servers send DMARC reports here.
										</p>
										<CopyField label="RUA" value={`rua=mailto:${domain.rua_address.trim()}`} />
									</>
								) : (
									<p className="text-sm text-ink-2">No reports address is configured for this domain, so there is no rua= value to add yet.</p>
								)}
							</div>
							<Link className="inline-block text-sm text-brand-ink underline underline-offset-4" to={`/domains/${domain.id}/reports`}>
								All reports
							</Link>
						</div>
					</Disclosure>
				)}

				{!reportsOff && (failing > 0 || sources.isError) ? (
					<Disclosure title="Failing senders" summary={sources.isError ? 'Could not be loaded.' : `${plural(failing, 'source')} sent mail that failed DMARC in the last 7 days.`}>
						<FailingSources domainId={domain.id} q={sources} />
					</Disclosure>
				) : null}

				{enforcing || rollout.isError ? (
					<Disclosure
						title="Rollout"
						summary={rollout.data && enforcing ? `Step ${rollout.data.current_step_index + 1} of ${rollout.data.total_steps}, at p=${rollout.data.current_policy}.${rollout.data.next_step ? '' : ' Fully graduated.'}` : 'Could not be loaded.'}
					>
						<Rollout domain={domain} />
					</Disclosure>
				) : null}

				{parent || children.length > 0 ? (
					<Disclosure title={parent ? 'Parent domain' : 'Subdomains'} summary={parent ? `Subdomain of ${parent.domain}.` : `${plural(children.length, 'subdomain')} monitored.`}>
						<Context domain={domain} all={all} />
					</Disclosure>
				) : null}

				{/* A name DNS says does not exist has no records to report on: the DNS records section says so once. */}
				{nxdomain ? null : (
				<Disclosure
					onOpenChange={(o) => o && setHealthOpen(true)}
					title="Email health report"
					summary={
						!healthOpen
							? 'Live DNS findings and proposed fixes, checked when you open this: the same evidence your authorized agent sees.'
							: health.isPending
							? 'Checking live DNS and collected evidence…'
							: health.isError
								? 'Could not be loaded.'
								: `${plural(health.data.dns.findings.length, 'finding')} and ${plural(health.data.remediation.length, 'proposed fix', 'proposed fixes')}: the same evidence your authorized agent sees.`
					}
				>
					<HealthReportSection domainId={domain.id} enabled={healthOpen} />
				</Disclosure>
				)}

				{toolsShown ? (
					<Disclosure title="DNS tools" summary="Optional tools that change your DNS for you: SPF flattening and MTA-STS.">
						<DnsTools domainId={domain.id} />
					</Disclosure>
				) : null}
			</div>
		</div>
	);
}

export function DomainDetailPage() {
	const id = useDomainId();
	const list = useDomains();
	const { domain } = useDomain(id);
	if (list.isPending) return <PageSkeleton label="Loading domain" />;
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
	return <DomainDetail domain={domain} all={list.data} />;
}
