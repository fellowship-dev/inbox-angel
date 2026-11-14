import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { domainKeys, invalidateDomain } from './domain-queries';
import { HOSTED_CONFIG_KEY } from './hosted';

/**
 * A domain's DMARC report address on the hosted service (GET/POST/DELETE /api/domains/:id/report-address, and
 * POST …/rotate). Dormant unless GET /api/hosted/config says `reports: true` (MODE=saas with INTAKE_DOMAIN).
 * Every field mirrors src/hosted/report-address.ts; the plan comes from packages/dns-checks/src/dmarc-rua.ts.
 */
export type ReportAddressState = 'not_issued' | 'not_published' | 'waiting' | 'receiving' | 'unknown';

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
	| { kind: 'inherited'; from: string; parent_record: string; policy: string; parent_has_address: boolean; own: OwnPlan };

export interface ReportAddressView {
	available: true;
	domain_id: number;
	domain: string;
	managed_by: 'hosted_records' | null;
	can_issue: boolean;
	refusal: string | null;
	address: string | null;
	issued_at: number | null;
	rotated_at: number | null;
	previous_valid_until: number | null;
	last_report_at: number | null;
	state: ReportAddressState;
	dns: { checked_at: number; error: string | null; plan: ReportAddressPlan | null } | null;
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
	const issue = useMutation({ mutationFn: () => api<ReportIntakeStatus>(base, { method: 'POST', body: {} }), onSuccess: settle });
	const rotate = useMutation({ mutationFn: () => api<ReportIntakeStatus>(`${base}/rotate`, { method: 'POST', body: {} }), onSuccess: settle });
	const revoke = useMutation({ mutationFn: () => api<ReportIntakeStatus>(base, { method: 'DELETE' }), onSuccess: settle });
	return { issue, rotate, revoke };
}
