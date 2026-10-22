import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** GET /api/analytics and GET /api/domains/:id/analytics (src/analytics/routes.ts). */
export interface TrendDay {
	day: string;
	total: number;
	passed: number;
	failed: number;
}

export interface Sender {
	source_ip: string;
	reverse_dns: string | null;
	base_domain: string | null;
	org: string | null;
	country_code: string | null;
	provider: { id: string; name: string; evidence: string } | null;
	domains: string[];
	messages: number;
	share_pct: number;
	spf_aligned_pct: number;
	dkim_aligned_pct: number;
	dmarc_pass_pct: number;
	spf_domain: string | null;
	dkim_domain: string | null;
	first_seen: number;
	last_seen: number;
	is_new: boolean;
}

export type FixKind = 'authorize-sender' | 'fix-dkim-alignment' | 'investigate-sender' | 'review-new-sender';

export interface Fix {
	id: string;
	kind: FixKind;
	severity: 'high' | 'medium' | 'low';
	domain: string;
	domain_id: number;
	sender: { name: string; provider_id: string | null; ips: string[] };
	title: string;
	detail: string;
	share_pct: number;
	affected_pct: number;
	affected_messages: number;
	steps: string[];
	records: Array<{ type: string; name: string; value: string }>;
	guide_url: string | null;
}

export type ReadinessStatus = 'ready' | 'caution' | 'blocked' | 'insufficient_data' | 'complete' | 'no_policy';

export interface Readiness {
	status: ReadinessStatus;
	headline: string;
	current: { policy: string | null; testing: boolean; step: number; label: string };
	next: { policy: string; testing: boolean; label: string } | null;
	total_steps: number;
	reasons: Array<{ level: 'ok' | 'warn' | 'block'; text: string }>;
	metrics: { messages: number; pass_rate: number | null; days_with_reports: number; window_days: number };
	policy_source: 'dns' | 'stored';
}

export interface Totals {
	messages: number;
	passed: number;
	failed: number;
	pass_rate: number | null;
	days_with_reports: number;
}

export interface DomainAnalytics {
	days: number;
	domain: { id: number; domain: string };
	totals: Totals;
	trend: TrendDay[];
	senders: Sender[];
	sender_count: number;
	fixes: Fix[];
	readiness: Readiness;
}

export interface AccountAnalytics {
	days: number;
	totals: Totals;
	trend: TrendDay[];
	senders: Sender[];
	sender_count: number;
	fixes: Fix[];
	domains: Array<{
		domain_id: number;
		domain: string;
		dmarc_policy: string | null;
		messages: number;
		pass_rate: number | null;
		readiness: { status: ReadinessStatus; headline: string; next: Readiness['next']; policy_source: 'stored' };
	}>;
}

export const analyticsKeys = {
	account: (days: number) => ['analytics', 'account', days] as const,
	domain: (id: number, days: number) => ['analytics', 'domain', id, days] as const,
};

export const useAccountAnalytics = (days: number) =>
	useQuery({ queryKey: analyticsKeys.account(days), queryFn: () => api<AccountAnalytics>(`/api/analytics?days=${days}`), placeholderData: (p) => p });

export const useDomainAnalytics = (id: number, days: number) =>
	useQuery({ queryKey: analyticsKeys.domain(id, days), queryFn: () => api<DomainAnalytics>(`/api/domains/${id}/analytics?days=${days}`), enabled: !Number.isNaN(id), placeholderData: (p) => p });

/** "mail.example.net (Example Hosting)", the bare IP, or the provider name when known. */
export function senderName(s: Pick<Sender, 'provider' | 'reverse_dns' | 'base_domain' | 'org' | 'source_ip'>): string {
	if (s.provider) return s.provider.name;
	const host = s.reverse_dns || s.base_domain;
	return host && s.org ? `${host} (${s.org})` : host || s.org || s.source_ip;
}

export const READINESS_LABEL: Record<ReadinessStatus, string> = {
	ready: 'Ready',
	caution: 'Proceed with care',
	blocked: 'Not yet',
	insufficient_data: 'Not enough data',
	complete: 'Fully enforced',
	no_policy: 'No policy',
};

export const SEVERITY_LABEL: Record<Fix['severity'], string> = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };

/** Whole percents from 10 up, one decimal below: `12.6` -> "13%", `4.25` -> "4.3%". Matches the API's own titles. */
export const fmtPct = (n: number | null): string => (n === null ? 'n/a' : n >= 10 || Number.isInteger(n) ? `${Math.round(n)}%` : `${n.toFixed(1)}%`);

/** Daily points folded into weeks (Monday start) for the 90-day view, so bars stay readable. Order is kept. */
export function bucketTrend(days: TrendDay[], size: 'day' | 'week'): TrendDay[] {
	if (size === 'day') return days;
	const out: TrendDay[] = [];
	for (const d of days) {
		const t = new Date(`${d.day}T00:00:00Z`);
		const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400_000).toISOString().slice(0, 10);
		const last = out[out.length - 1];
		if (last && last.day === monday) {
			last.total += d.total;
			last.passed += d.passed;
			last.failed += d.failed;
		} else out.push({ day: monday, total: d.total, passed: d.passed, failed: d.failed });
	}
	return out;
}
