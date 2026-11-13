import { CheckResult, CheckResultList, RecordBlock, Skeleton, toast, type CheckStatus } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { isRevokedDkimKey } from '../../lib/dkim';
import { buildRecommendedRecord, hasReportAddress } from '../../lib/dmarc-record';
import { domainKeys, invalidateDomain, useDnsCheck, useOnboardingStatus } from '../../lib/domain-queries';
import { useHosted } from '../../lib/session';
import type { Domain } from '../../lib/types';
import { Section, WriteButton } from '../states';
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
	const recommended = buildRecommendedRecord(current, policy, domain.rua_address);
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

	const dmarcRow = (() => {
		if (dns.isPending) return <RowSkeleton label="DMARC" />;
		if (dns.isError || dns.data.error) {
			return <CheckResult status="error" title="DMARC record" summary={dns.isError ? errorMessage(dns.error) : 'The DNS lookup did not complete.'} onRetry={() => void dns.refetch()} />;
		}
		const { found } = dns.data;
		// Without a report address of our own, no record can send reports here, whatever the lookup matched.
		const has_rua = dns.data.has_rua && ruaReady;
		const status: CheckStatus = hostedNoReports ? (found ? 'pass' : 'missing') : found && has_rua ? 'pass' : found ? 'warn' : 'missing';
		const upToDate = hostedNoReports ? found : !ruaReady || (found && has_rua && current === recommended);
		return (
			<CheckResult
				status={status}
				statusLabel={hostedNoReports && found ? 'Published' : undefined}
				title="DMARC record"
				summary={
					hostedNoReports
						? found
							? 'Published, read from public DNS. Reports are not connected yet, so it sends no reports to Inbox Angel.'
							: `No TXT record at ${dmarcName}. Publish the record below: p=none only monitors, so no mail is blocked or redirected.`
						: !ruaReady
						? `${found ? 'Published' : `No TXT record at ${dmarcName}`}. This domain has no Inbox Angel report address yet, so there is no record to suggest.`
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
		const { selectors } = onboarding.data.dkim;
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
				{dmarcRow}
				{spfRow}
				{dkimRow}
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
