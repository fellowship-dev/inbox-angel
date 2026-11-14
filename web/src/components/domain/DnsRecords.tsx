import { CheckResult, CheckResultList, RecordBlock, Skeleton, toast, type CheckStatus } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { isRevokedDkimKey } from '../../lib/dkim';
import { DKIM_WILDCARD_LABEL, dkimWildcardSummary } from '../../lib/dkim-wildcard';
import { buildRecommendedRecord, hasReportAddress, parseDmarcPolicy } from '../../lib/dmarc-record';
import { dmarcCoverage, inheritedSentence, offerPolicy } from '../../lib/dmarc-coverage';
import { domainKeys, invalidateDomain, useDnsCheck, useOnboardingStatus } from '../../lib/domain-queries';
import { useHosted } from '../../lib/session';
import type { Domain } from '../../lib/types';
import { Section, WriteButton } from '../states';
import { HELP_PRIORITY, TalkToMax } from '../TalkToMax';
import { ConfirmDialog } from './ConfirmDialog';

const SPF_LOOKUP_LIMIT = 10;

function RowSkeleton({ label }: { label: string }) {
	return (
		<li aria-busy="true" className="rounded-lg border border-line p-4">
			<Skeleton className="h-5 w-1/3" />
			<span className="sr-only">Checking {label}…</span>
		</li>
	);
}

function spfStatus(count: number | null): { status: CheckStatus; note: string | null } {
	if (count === null) return { status: 'pass', note: null };
	if (count > SPF_LOOKUP_LIMIT) return { status: 'fail', note: `${count} of ${SPF_LOOKUP_LIMIT} DNS lookups. Over the limit, so receivers may reject your SPF record. Flattening can fix this.` };
	if (count >= 8) return { status: 'warn', note: `${count} of ${SPF_LOOKUP_LIMIT} DNS lookups. Close to the limit.` };
	return { status: 'pass', note: `${count} of ${SPF_LOOKUP_LIMIT} DNS lookups.` };
}

/** DMARC, SPF and DKIM as the DNS shows them now. A failed lookup is "Lookup failed", never "Not found". */
export function DnsRecords({ domain }: { domain: Domain }) {
	const qc = useQueryClient();
	const dns = useDnsCheck(domain.id);
	const onboarding = useOnboardingStatus(domain.id);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const current = dns.data?.current_record ?? null;
	const policy = current?.match(/\bp=([a-z]+)/)?.[1] ?? 'none';
	const ruaReady = hasReportAddress(domain.rua_address);
	// Hosted, before report intake: no report address exists, but a missing record still gets a plain p=none to publish.
	const hostedNoReports = useHosted() && !ruaReady;
	// No record of its own: a new one replaces what the name inherits, so it starts at the inherited policy when that
	// enforces, and nothing is offered while the policy that applies is unknown. Never weaker than the effective policy.
	const coverage = dmarcCoverage(onboarding.data ?? null, onboarding.isError || (onboarding.data?.dns_errors ?? []).some((e) => e.startsWith('dmarc:')));
	const floor = current ? policy : offerPolicy(coverage);
	const recommended = buildRecommendedRecord(current, floor ?? 'none', domain.rua_address);
	const dmarcName = `_dmarc.${domain.domain}`;
	const cfAvailable = !!(dns.data?.cf_managed || onboarding.data?.cf_available);

	const apply = useMutation({
		mutationFn: () => api(`/api/domains/${domain.id}/apply-dmarc`, { method: 'POST', body: { record: recommended } }),
		onSuccess: async () => {
			toast({ title: 'DMARC record applied', description: `${dmarcName} was updated. DNS can take a few minutes to propagate.`, variant: 'success' });
			setConfirmOpen(false);
			await Promise.all([qc.invalidateQueries({ queryKey: domainKeys.dnsCheck(domain.id) }), qc.invalidateQueries({ queryKey: domainKeys.onboarding(domain.id) }), invalidateDomain(qc, domain.id)]);
		},
	});

	/**
	 * Hosted, before report intake: no report address, so the row judges what DNS shows. A p=none record is offered only
	 * when no policy applies at all; an inherited policy is explained, never undercut by a weaker record of its own.
	 */
	function hostedDmarcRow() {
		if (current) {
			const p = parseDmarcPolicy(current);
			const enforcing = p === 'quarantine' || p === 'reject';
			return (
				<CheckResult
					status={enforcing ? 'pass' : 'warn'}
					statusLabel={enforcing ? 'Published' : 'Worth fixing'}
					title="DMARC record"
					summary={
						enforcing
							? 'Published, read from public DNS. Reports are not connected yet, so it sends no reports to Inbox Angel.'
							: `Published, read from public DNS. ${p === 'none' ? 'p=none only monitors: mail that fails SPF and DKIM is still delivered.' : 'It has no valid p= policy, so receivers ignore it.'} Reports are not connected yet, so it sends no reports to Inbox Angel.`
					}
				>
					<RecordBlock title="Current record" record={{ type: 'TXT', name: dmarcName, value: current }} />
				</CheckResult>
			);
		}
		if (onboarding.isPending) return <RowSkeleton label="DMARC" />;
		if (coverage.kind === 'inherited') {
			const enforcing = coverage.policy === 'quarantine' || coverage.policy === 'reject';
			return (
				<CheckResult
					status={enforcing ? 'pass' : 'warn'}
					statusLabel={coverage.policy ? `Inherited (p=${coverage.policy})` : 'Inherited, no policy'}
					title="DMARC record"
					summary={inheritedSentence(domain.domain, coverage)}
				/>
			);
		}
		if (coverage.kind === 'none') {
			return (
				<CheckResult status="missing" title="DMARC record" summary={`No DMARC policy applies to ${domain.domain}: there is no record at ${dmarcName} and none to inherit. Publish this record: p=none only monitors, so no mail is blocked or redirected.`}>
					<div className="space-y-3">
						<RecordBlock title="Add this record" record={{ type: 'TXT', name: dmarcName, value: buildRecommendedRecord(null, 'none', null), ttl: 3600 }} />
						<p className="text-ink-2">Add this record at your DNS provider.</p>
					</div>
				</CheckResult>
			);
		}
		return (
			<CheckResult
				status="error"
				title="DMARC record"
				summary={`There is no record at ${dmarcName}, and we could not tell whether a parent domain's policy covers this name, so no record is offered.`}
				onRetry={() => void onboarding.refetch()}
			/>
		);
	}

	const dmarcRow = (() => {
		if (dns.isPending) return <RowSkeleton label="DMARC" />;
		if (dns.isError || dns.data.error) {
			return <CheckResult status="error" title="DMARC record" summary={dns.isError ? errorMessage(dns.error) : 'The DNS lookup did not complete.'} onRetry={() => void dns.refetch()} />;
		}
		const { found } = dns.data;
		if (hostedNoReports) return hostedDmarcRow();
		if (!found && ruaReady && onboarding.isPending) return <RowSkeleton label="DMARC" />;
		// Without a report address of our own, no record can send reports here, whatever the lookup matched.
		const has_rua = dns.data.has_rua && ruaReady;
		const status: CheckStatus = found && has_rua ? 'pass' : found ? 'warn' : !found && coverage.kind === 'inherited' && (coverage.policy === 'quarantine' || coverage.policy === 'reject') ? 'warn' : 'missing';
		const offerBlocked = !found && floor === null;
		const upToDate = !ruaReady || offerBlocked || (found && has_rua && current === recommended);
		return (
			<CheckResult
				status={status}
				title="DMARC record"
				summary={
					!ruaReady
						? `${found ? 'Published' : `No TXT record at ${dmarcName}`}. This domain has no Inbox Angel report address yet, so there is no record to suggest.`
						: !found && offerBlocked
							? `No TXT record at ${dmarcName}, and we could not tell whether a parent domain's policy covers this name, so no record is offered.`
							: !found && coverage.kind === 'inherited'
								? `${inheritedSentence(domain.domain, coverage)} To receive reports here, publish the record below: it keeps p=${floor} and adds Inbox Angel's report address.`
							: !found
							? `No TXT record at ${dmarcName}. Add the record below so reports start arriving.`
							: has_rua
								? 'Published, and aggregate reports are sent to Inbox Angel.'
								: `Published, but it does not send reports to ${domain.rua_address}. Update it with the record below.`
				}
			>
				<div className="space-y-3">
					{current ? <RecordBlock title="Current record" record={{ type: 'TXT', name: dmarcName, value: current }} /> : null}
					{!upToDate ? (
						<>
							<RecordBlock title={found ? 'Recommended record' : 'Add this record'} record={{ type: 'TXT', name: dmarcName, value: recommended, ttl: 3600 }} />
							{cfAvailable ? (
								<WriteButton size="sm" onClick={() => setConfirmOpen(true)}>
									Apply to Cloudflare
								</WriteButton>
							) : (
								<p className="text-ink-2">Add this record at your DNS provider. Inbox Angel cannot change DNS for this domain.</p>
							)}
						</>
					) : null}
				</div>
			</CheckResult>
		);
	})();

	const errors = onboarding.data?.dns_errors ?? [];
	const retryOnboarding = () => void onboarding.refetch();

	const spfRow = (() => {
		if (onboarding.isPending) return <RowSkeleton label="SPF" />;
		if (onboarding.isError) return <CheckResult status="error" title="SPF record" summary={errorMessage(onboarding.error)} onRetry={retryOnboarding} />;
		const { spf } = onboarding.data;
		if (errors.some((e) => e.startsWith('spf:'))) return <CheckResult status="error" title="SPF record" summary="The DNS lookup did not complete." onRetry={retryOnboarding} />;
		if (!spf.record) {
			return <CheckResult status="missing" title="SPF record" summary="No SPF record found. Receivers cannot tell which servers may send for you." />;
		}
		const { status, note } = spfStatus(spf.lookup_count);
		return (
			<CheckResult status={status} title="SPF record" summary={note ?? 'Published.'}>
				<div className="space-y-2">
					<RecordBlock record={{ type: 'TXT', name: domain.domain, value: spf.record }} />
					{spf.flattening_active ? <p className="text-ink-2">SPF flattening is active for this domain.</p> : null}
				</div>
			</CheckResult>
		);
	})();

	const dkimRow = (() => {
		if (onboarding.isPending) return <RowSkeleton label="DKIM" />;
		if (onboarding.isError) return <CheckResult status="error" title="DKIM selectors" summary={errorMessage(onboarding.error)} onRetry={retryOnboarding} />;
		const { selectors, wildcard } = onboarding.data.dkim;
		if (wildcard) return <CheckResult status="neutral" title="DKIM selectors" statusLabel={DKIM_WILDCARD_LABEL} summary={dkimWildcardSummary(domain.domain)} />;
		const dkimFailed = errors.some((e) => e.startsWith('dkim'));
		if (selectors.length === 0 && dkimFailed) return <CheckResult status="error" title="DKIM selectors" summary="The DNS lookups did not complete." onRetry={retryOnboarding} />;
		if (selectors.length === 0) {
			return (
				<CheckResult
					status="missing"
					title="DKIM selectors"
					summary="No DKIM record found for the selectors we check. Your provider may use another selector; ask them which one to publish."
				/>
			);
		}
		// An empty p= is a revoked key: published, but nothing it signs can pass. Only usable keys count.
		const revoked = selectors.filter((s) => isRevokedDkimKey(s.record)).length;
		const usable = selectors.length - revoked;
		const partial = dkimFailed ? ' Some selectors could not be checked.' : '';
		const revokedNote = `${revoked} ${revoked === 1 ? 'selector has' : 'selectors have'} an empty key (p=), which means revoked.`;
		return (
			<CheckResult
				status={usable > 0 ? 'pass' : 'fail'}
				title="DKIM selectors"
				summary={
					usable > 0
						? `${usable} usable key${usable === 1 ? '' : 's'} found.${revoked > 0 ? ` ${revokedNote}` : ''}${partial}`
						: `No usable DKIM key. ${revokedNote}${partial}`
				}
			>
				<div className="space-y-2">
					{selectors.map((s) => (
						<RecordBlock
							key={s.name}
							title={isRevokedDkimKey(s.record) ? 'Revoked: empty key' : undefined}
							record={{ type: /v=DKIM1|p=/i.test(s.record) ? 'TXT' : 'CNAME', name: s.name, value: s.record }}
						/>
					))}
				</div>
			</CheckResult>
		);
	})();

	return (
		<Section title="DNS records" description="Read live from DNS. A lookup that fails is shown as such and never counted as a missing record.">
			<CheckResultList aria-label="DNS records">
				{onboarding.data?.nxdomain ? (
					// DNS says the name does not exist: the same verdict as the overview card, not three "not found" rows.
					<CheckResult
						status="missing"
						statusLabel="Does not resolve"
						title="This domain does not resolve"
						summary="DNS says this name does not exist, so there are no SPF, DKIM or DMARC records to check. Check the spelling, or register the domain."
						onRetry={retryOnboarding}
					>
						<TalkToMax priority={HELP_PRIORITY.dnsFailing} lead="Sure this is the right name?" about={`about ${domain.domain}`} />
					</CheckResult>
				) : (
					<>
						{dmarcRow}
						{spfRow}
						{dkimRow}
					</>
				)}
			</CheckResultList>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={(o) => {
					setConfirmOpen(o);
					if (!o) apply.reset();
				}}
				title="Apply the DMARC record?"
				description={`This writes the TXT record at ${dmarcName} in your Cloudflare zone.`}
				confirmLabel="Apply record"
				busyLabel="Applying…"
				busy={apply.isPending}
				error={apply.isError ? errorMessage(apply.error) : null}
				onConfirm={() => apply.mutate()}
			>
				<RecordBlock record={{ type: 'TXT', name: dmarcName, value: recommended, ttl: 3600 }} />
			</ConfirmDialog>
		</Section>
	);
}
