import { Alert, Badge, Button, EmptyState, PageHeader, Stat, StatGroup, Tabs, TabsList, TabsTrigger } from '@inbox-angel/ui';
import { ArrowLeft, BarChart3, Settings } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDomainId } from '../../app';
import { DailyChart } from '../../components/domain/DailyChart';
import { CopyField } from '../../components/domain/CopyField';
import { DnsRecords } from '../../components/domain/DnsRecords';
import { DnsTools } from '../../components/domain/DnsTools';
import { FailingSources } from '../../components/domain/FailingSources';
import { HostedPanel } from '../../components/hosted/HostedPanel';
import { Rollout } from '../../components/domain/Rollout';
import { ListSkeleton, LoadError, PageSkeleton, ReadOnlyNotice, Section } from '../../components/states';
import { getGuidance, spTag, sumStats, wizardProgress, type GuidanceTone } from '../../lib/dmarc';
import { useDnsCheck, useFailingSources, useStats, useWizardState } from '../../lib/domain-queries';
import { formatNumber } from '../../lib/format';
import { useDomain, useDomains } from '../../lib/queries';
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
	if (dns.isPending) return <Badge variant="outline">Checking DMARC policy…</Badge>;
	const lastKnown = domain.dmarc_policy && domain.dmarc_policy !== 'none' ? ` (last known policy: p=${domain.dmarc_policy})` : '';
	if (dns.isError || dns.data.error) return <Badge variant="outline">DMARC lookup failed{lastKnown}</Badge>;
	if (!dns.data.found || !dns.data.current_record) return <Badge variant="outline">No DMARC record found{lastKnown}</Badge>;
	const live = dns.data.current_record.match(/(^|;\s*)p=([a-z]+)/i)?.[2]?.toLowerCase();
	return live ? <PolicyBadge policy={live as Domain['dmarc_policy']} /> : <Badge variant="outline">DMARC record has no p= tag</Badge>;
}

function SetupBanner({ domainId }: { domainId: number }) {
	const q = useWizardState(domainId);
	if (!q.data) return null; // a failed lookup of setup progress should not block the page
	const { done, total, nextStep } = wizardProgress(q.data);
	if (done >= total) return null;
	return (
		<Alert variant="warning" title={`Setup incomplete: ${done}/${total} steps done`}>
			<Link to={`/domains/${domainId}/setup/${nextStep}`}>Continue setup</Link>
		</Alert>
	);
}

function Context({ domain, all }: { domain: Domain; all: Domain[] }) {
	const dns = useDnsCheck(domain.id);
	const parent = domain.parent_id ? all.find((d) => d.id === domain.parent_id) : undefined;
	const children = all.filter((d) => d.parent_id === domain.id);
	if (!parent && children.length === 0) return null;
	const record = dns.data?.current_record ?? null;
	const sp = spTag(record);
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

function DomainDetail({ domain, all }: { domain: Domain; all: Domain[] }) {
	const [days, setDays] = useState<number>(7);
	const stats = useStats(domain.id, days);
	const sources = useFailingSources(domain.id);
	const dns = useDnsCheck(domain.id);

	const sums = stats.data ? sumStats(stats.data.stats) : null;
	const guidance = sums ? getGuidance(domain, sums.passRate, sums.total > 0) : null;

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
			<SetupBanner domainId={domain.id} />

			<Section
				title="Results"
				actions={
					<Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
						<TabsList aria-label="Time window">
							{WINDOWS.map((w) => (
								<TabsTrigger key={w} value={String(w)}>
									{w}d<span className="sr-only"> window</span>
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
				}
			>
				{stats.isPending ? (
					<ListSkeleton rows={1} label="Loading results" />
				) : stats.isError ? (
					<LoadError error={stats.error} onRetry={() => void stats.refetch()} title="Could not load results" />
				) : (
					<>
						<StatGroup className="sm:grid-cols-4" aria-label={`Last ${days} days`}>
							<Stat label="Pass rate" value={sums?.passRate != null ? `${sums.passRate}%` : 'n/a'} />
							<Stat label="Total" value={formatNumber(sums?.total ?? 0)} />
							<Stat label="Passed" value={formatNumber(sums?.passed ?? 0)} />
							<Stat label="Failed" value={formatNumber(sums?.failed ?? 0)} />
						</StatGroup>
						{guidance ? (
							<Alert variant={ALERT_VARIANT[guidance.tone]} title={guidance.title}>
								<p>{guidance.body}</p>
								{guidance.upgradeTo ? (
									<Button asChild size="sm" className="mt-3">
										<Link to={`/domains/${domain.id}/dmarc-wizard`}>Upgrade to {guidance.upgradeTo}</Link>
									</Button>
								) : null}
								{sums?.total === 0 && dns.data ? (
									<p className="mt-2 italic">
										{dns.data.error
											? 'We could not check your DNS record just now. See DNS records below.'
											: dns.data.found && dns.data.has_rua
												? 'DNS record detected. Reports will start arriving soon.'
												: 'DNS record not found yet. Make sure you have added it, then wait a few minutes for propagation.'}
									</p>
								) : null}
							</Alert>
						) : null}
					</>
				)}
			</Section>

			<HostedPanel key={domain.id} domainId={domain.id} />
			<DnsRecords domain={domain} />
			<Rollout domain={domain} />

			<Section
				title={`Last ${days} days`}
				actions={
					<Link className="text-sm text-brand-ink underline underline-offset-4" to={`/domains/${domain.id}/reports`}>
						All reports
					</Link>
				}
			>
				{stats.isPending ? <ListSkeleton rows={1} label="Loading daily results" /> : stats.isError ? null : <DailyChart domainId={domain.id} stats={stats.data.stats} days={days} />}
			</Section>

			<Section title="RUA reporting address" description={<>Add this to your <code>_dmarc.{domain.domain}</code> TXT record so receiving servers send DMARC reports here.</>}>
				<CopyField label="RUA" value={`rua=mailto:${domain.rua_address}`} />
			</Section>

			<Context domain={domain} all={all} />
			<FailingSources domainId={domain.id} q={sources} />
			<DnsTools domainId={domain.id} />
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
