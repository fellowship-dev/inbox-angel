import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { DomainCheckSummary, DomainStats, FailingSource, MtaStsStatus, OnboardingStatus, SpfFlatStatus, WizardState } from './types';

/** GET /api/domains/:id/dns-check. `error` is set when the lookup itself failed: that is not "no record". */
export interface DnsCheck {
	found: boolean;
	has_rua: boolean;
	current_record: string | null;
	cf_managed: boolean;
	error?: string;
}

/** GET /api/domains/:id/onboarding-status; `dns_errors` lists lookups that failed ("spf: …", "dmarc: …", "dkim sel: …"). */
export type OnboardingResult = OnboardingStatus & { dns_errors?: string[] };

export interface RolloutNext {
	current_policy: string | null;
	current_pct: number | null;
	current_testing: boolean;
	current_record: string | null;
	current_step_index: number;
	total_steps: number;
	next_step: { policy: string; testing: boolean } | null;
	next_step_note: string | null;
	dns_preview: string | null;
	pass_rate: number | null;
	blocked: boolean;
	block_reason: string | null;
	has_unknown_senders: boolean;
	behind_schedule: boolean;
	recommended_policy: string | null;
	recommended_pct: number | null;
}

export interface MonitorSub {
	id: number;
	email: string;
	domain: string;
	active: number;
	created_at: number;
}

export interface BulkImportItem {
	domain: string;
	status: 'imported' | 'duplicate' | 'invalid' | 'error';
	error?: string;
	dns_record_id?: string | null;
	manual_dns?: boolean;
}

export interface BulkImportResponse {
	imported: number;
	total: number;
	results: BulkImportItem[];
}

/** All per-domain data hangs under ['domain-data', id] so one invalidation refreshes a page. */
export const domainKeys = {
	all: (id: number) => ['domain-data', id] as const,
	summary: (id: number) => ['domain-data', id, 'check-summary'] as const,
	stats: (id: number, days: number) => ['domain-data', id, 'stats', days] as const,
	wizard: (id: number) => ['domain-data', id, 'wizard-state'] as const,
	sources: (id: number) => ['domain-data', id, 'sources'] as const,
	dnsCheck: (id: number) => ['domain-data', id, 'dns-check'] as const,
	onboarding: (id: number) => ['domain-data', id, 'onboarding-status'] as const,
	rollout: (id: number) => ['domain-data', id, 'rollout-next'] as const,
	spf: (id: number) => ['domain-data', id, 'spf-flatten'] as const,
	mta: (id: number) => ['domain-data', id, 'mta-sts'] as const,
	monitorSubs: (id: number) => ['domain-data', id, 'monitor-subs'] as const,
	zones: ['zones'] as const,
};

export const fetchSummary = (id: number) => api<DomainCheckSummary>(`/api/domains/${id}/check-summary`);
export const fetchStats = (id: number, days: number) => api<DomainStats>(`/api/domains/${id}/stats?days=${days}`);

export const useCheckSummary = (id: number) => useQuery({ queryKey: domainKeys.summary(id), queryFn: () => fetchSummary(id) });
export const useStats = (id: number, days: number) =>
	useQuery({ queryKey: domainKeys.stats(id, days), queryFn: () => fetchStats(id, days), placeholderData: (prev) => prev });
export const useWizardState = (id: number) => useQuery({ queryKey: domainKeys.wizard(id), queryFn: () => api<WizardState>(`/api/domains/${id}/wizard-state`) });
export const useFailingSources = (id: number) =>
	useQuery({ queryKey: domainKeys.sources(id), queryFn: () => api<{ sources: FailingSource[] }>(`/api/domains/${id}/sources?days=7`).then((r) => r.sources) });
export const useDnsCheck = (id: number) => useQuery({ queryKey: domainKeys.dnsCheck(id), queryFn: () => api<DnsCheck>(`/api/domains/${id}/dns-check`) });
export const useOnboardingStatus = (id: number) =>
	useQuery({ queryKey: domainKeys.onboarding(id), queryFn: () => api<OnboardingResult>(`/api/domains/${id}/onboarding-status`) });
export const useRolloutNext = (id: number) => useQuery({ queryKey: domainKeys.rollout(id), queryFn: () => api<RolloutNext>(`/api/domains/${id}/rollout-next`) });
export const useSpfFlatten = (id: number) => useQuery({ queryKey: domainKeys.spf(id), queryFn: () => api<SpfFlatStatus>(`/api/domains/${id}/spf-flatten`) });
export const useMtaSts = (id: number) => useQuery({ queryKey: domainKeys.mta(id), queryFn: () => api<MtaStsStatus>(`/api/domains/${id}/mta-sts`) });
export const useMonitorSubs = (id: number) =>
	useQuery({ queryKey: domainKeys.monitorSubs(id), queryFn: () => api<{ subs: MonitorSub[] }>(`/api/domains/${id}/monitor-subs`).then((r) => r.subs) });

/** After a change to a domain: refresh the list and everything cached for it. */
export function invalidateDomain(qc: QueryClient, id: number): Promise<unknown> {
	return Promise.all([qc.invalidateQueries({ queryKey: ['domains'] }), qc.invalidateQueries({ queryKey: domainKeys.all(id) })]);
}

export function useInvalidateDomain(id: number) {
	const qc = useQueryClient();
	return () => invalidateDomain(qc, id);
}
