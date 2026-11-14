import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { domainKeys, invalidateDomain } from './domain-queries';
import { HOSTED_CONFIG_KEY } from './hosted';
import type { ReportVisibilityFields } from './uncounted';

/**
 * Connecting a domain's DMARC reports on the hosted service (GET/POST/DELETE /api/domains/:id/report-address): one
 * fixed address for every domain. Dormant unless GET /api/hosted/config says `reports: true` (MODE=saas with INTAKE_DOMAIN).
 * Every field mirrors src/hosted/report-address.ts; the plan comes from packages/dns-checks/src/dmarc-rua.ts.
 */
export type ReportAddressState = 'not_connected' | 'not_published' | 'waiting' | 'receiving' | 'unknown';

export interface RecordOption {
	replaces: string | null;
	record: string;
}

export type OwnPlan =
	| { kind: 'published'; name: string; record: string }
	| { kind: 'add'; name: string; current: string | null; record: string; created: boolean }
	| { kind: 'choose'; name: string; current: string | null; existing: string[]; options: RecordOption[]; created: boolean };

export type ReportAddressPlan =
	| OwnPlan
	| { kind: 'multiple'; name: string; records: string[] }
	| { kind: 'invalid'; name: string; record: string; issues: string[] }
	| { kind: 'inherited'; from: string; parent_record: string; policy: string; policy_tag: 'sp' | 'p'; parent_has_address: boolean; own: OwnPlan };

export interface ReportAddressView {
	available: true;
	domain_id: number;
	domain: string;
	managed_by: 'hosted_records' | null;
	can_connect: boolean;
	refusal: string | null;
	address: string | null;
	connected_at: number | null;
	/** The newest COUNTED report since connecting; counted reports, and all reports, since then; reports before this connection. */
	last_report_at: number | null;
	counted_since_connect: number;
	reports_since_connect: number;
	reports_before_connect: number;
	visibility?: ReportVisibilityFields | null;
	state: ReportAddressState;
	dns: { checked_at: number; error: string | null; plan: ReportAddressPlan | null } | null;
	parent?: { domain_id: number; domain: string; connected: boolean } | null;
}

export type ReportIntakeStatus = { available: false } | ReportAddressView;

export const reportAddressKey = (id: number) => [...domainKeys.all(id), 'report-address'] as const;

/** Can this deployment issue report addresses? Shares the hosted-config query; any failure counts as "no". */
export function useReportIntakeEnabled(): boolean {
	const q = useQuery({
		queryKey: HOSTED_CONFIG_KEY,
		queryFn: () => api<{ enabled: boolean; reports?: boolean; records?: boolean }>('/api/hosted/config'),
		staleTime: Infinity,
		retry: false,
	});
	return q.data?.enabled === true && q.data.reports === true;
}

export function useReportAddress(domainId: number, enabled = true) {
	return useQuery({
		queryKey: reportAddressKey(domainId),
		queryFn: () => api<ReportIntakeStatus>(`/api/domains/${domainId}/report-address`),
		enabled,
	});
}

export function useReportAddressMutations(domainId: number) {
	const qc = useQueryClient();
	const base = `/api/domains/${domainId}/report-address`;
	// The new status is the truth at once; the domain list (rua_address) and every per-domain view refresh after.
	const settle = (s: ReportIntakeStatus) => {
		qc.setQueryData(reportAddressKey(domainId), s);
		void invalidateDomain(qc, domainId);
	};
	const connect = useMutation({ mutationFn: () => api<ReportIntakeStatus>(base, { method: 'POST', body: {} }), onSuccess: settle });
	const disconnect = useMutation({ mutationFn: () => api<ReportIntakeStatus>(base, { method: 'DELETE' }), onSuccess: settle });
	return { connect, disconnect };
}
