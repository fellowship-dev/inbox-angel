import type { CheckStatus } from '@inbox-angel/ui';
import type { AnomalySource, CheckResult, ReportSource } from './types';

/** Pure helpers for the report, source, email-check and audit screens. */

export type AuthSource = Pick<ReportSource, 'source_ip' | 'header_from' | 'spf_domain' | 'dkim_domain' | 'spf_pass' | 'dkim_pass' | 'base_domain' | 'org'>;

export const WINDOWS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOWS)[number];
export const DEFAULT_WINDOW: WindowDays = 30;

/** A source not seen in this many days is probably fixed already. */
export const STALE_AFTER_DAYS = 2;

export const isFailing = (src: Pick<AuthSource, 'spf_pass' | 'dkim_pass'>): boolean => !src.spf_pass || !src.dkim_pass;

/** The sending service, when it differs from the From domain. */
export function serviceVia(src: Pick<AuthSource, 'spf_domain' | 'dkim_domain' | 'header_from'>): string | null {
	const auth = src.spf_domain || src.dkim_domain;
	if (!auth || auth === src.header_from) return null;
	return auth;
}

/** "Google" / "mailchimp.com", or null when the IP has no known owner. */
export const providerName = (src: Pick<AuthSource, 'org' | 'base_domain'>): string | null => src.org || src.base_domain || null;

export function failLabel(src: Pick<AuthSource, 'spf_pass' | 'dkim_pass'>): 'SPF + DKIM' | 'SPF' | 'DKIM' {
	if (!src.spf_pass && !src.dkim_pass) return 'SPF + DKIM';
	return !src.spf_pass ? 'SPF' : 'DKIM';
}

/** Plain-language explanation and fix for a source that failed SPF and/or DKIM. */
export function explain(src: AuthSource): string {
	const from = src.header_from ? `"${src.header_from}"` : 'your domain';
	const service = serviceVia(src) ?? 'this server';

	if (!src.spf_pass && !src.dkim_pass) {
		return (
			`${service} has no authorization to send as ${from}. ` +
			`If you don't recognize it, it's likely spoofed mail — your DMARC policy will handle it. ` +
			`If it's a service you added recently, you'll need to configure both SPF and DKIM for it.`
		);
	}
	if (!src.spf_pass) {
		const fix = src.spf_domain ? `Add include:${src.spf_domain} to your SPF record.` : 'Add this server to your SPF record.';
		return (
			`${service} isn't listed in your SPF record but is sending as ${from}. ` +
			`If this is a service you use (e.g. a newsletter tool or CRM), authorize it. ${fix}`
		);
	}
	return (
		`${service} sent mail without a valid DKIM signature for ${from}. ` +
		`SPF is passing, but DKIM isn't — configure DKIM signing for this service to fully protect your domain.`
	);
}

/** Still failing recently (`last_seen` is YYYY-MM-DD). */
export function isActive(lastSeen: string, now: Date = new Date()): boolean {
	const cutoff = new Date(now);
	cutoff.setDate(cutoff.getDate() - STALE_AFTER_DAYS);
	return new Date(lastSeen) >= cutoff;
}

export function splitActive<T extends Pick<AnomalySource, 'last_seen'>>(sources: T[], now: Date = new Date()): { active: T[]; older: T[] } {
	return { active: sources.filter((s) => isActive(s.last_seen, now)), older: sources.filter((s) => !isActive(s.last_seen, now)) };
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ── Dates ──────────────────────────────────────────────────────────────

/** Unix seconds to YYYY-MM-DD in UTC (the report-detail route key). */
export const isoDay = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

function toDate(value: number | string): Date {
	if (typeof value === 'number') return new Date(value * 1000);
	const [y = 0, m = 1, d = 1] = value.split('-').map(Number);
	return new Date(y, m - 1, d);
}

/** Unix seconds or YYYY-MM-DD to "Mar 18, 2026". */
export const formatDay = (value: number | string): string => toDate(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export function formatTimestamp(unix: number): string {
	return new Date(unix * 1000).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relativeTime(value: number | string, now = Date.now()): string {
	const diff = now - toDate(value).getTime();
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? ' ago' : ' from now';
	const MIN = 60_000;
	const DAY = 86_400_000;
	if (abs < MIN) return 'just now';
	if (abs < 60 * MIN) return `${Math.round(abs / MIN)}m${suffix}`;
	if (abs < DAY) return `${Math.round(abs / (60 * MIN))}h${suffix}`;
	if (abs < 7 * DAY) return `${Math.round(abs / DAY)}d${suffix}`;
	if (abs < 30 * DAY) return `${Math.round(abs / (7 * DAY))}w${suffix}`;
	if (abs < 365 * DAY) return `${Math.round(abs / (30 * DAY))}mo${suffix}`;
	return `${Math.round(abs / (365 * DAY))}y${suffix}`;
}

export const formatDayWithRelative = (value: number | string, now = Date.now()): string => `${formatDay(value)} · ${relativeTime(value, now)}`;

/** Pass rate as a whole percent, or null when nothing was sent. */
export const passRate = (passed: number, total: number): number | null => (total > 0 ? Math.round((passed / total) * 100) : null);

export type RateTone = 'success' | 'warning' | 'danger';
export const rateTone = (pct: number): RateTone => (pct >= 95 ? 'success' : pct >= 70 ? 'warning' : 'danger');

// ── Email check ────────────────────────────────────────────────────────

export const CHECK_POLL_MS = 3000;
/** After this long without an email we stop polling and say so. */
export const CHECK_GIVE_UP_MS = 5 * 60 * 1000;

/** Raw protocol result to the design-system status. `softfail` is a warning, anything unexpected a fail. */
export function protocolStatus(result: string | null): CheckStatus {
	if (!result || result === 'none') return 'missing';
	if (result === 'pass') return 'pass';
	if (result === 'softfail' || result === 'neutral') return 'warn';
	return 'fail';
}

export function spfStatus(result: string | null, lookups: number | null): CheckStatus {
	const s = protocolStatus(result);
	if (s === 'pass' && lookups !== null && lookups >= 8) return 'warn';
	return s;
}

export function spfAdvice(result: string | null, lookupCount: number | null): string {
	if (!result || result === 'none') return 'No SPF record found. Add a TXT record to your DNS: v=spf1 include:your-mail-provider.com ~all';
	if (result === 'permerror') {
		return `SPF permerror — your record requires ${lookupCount ?? '?'} DNS lookups, exceeding the 10-lookup limit. Receivers treat this as a fail. Flatten your SPF record or use a dynamic SPF service.`;
	}
	if (lookupCount !== null && lookupCount >= 10) {
		return `SPF passed this time, but your record needs ${lookupCount} DNS lookups — at or over the limit. Some receivers will return permerror and silently drop your mail. Flatten your includes or use a dynamic SPF service.`;
	}
	if (lookupCount !== null && lookupCount >= 8) {
		return `SPF passed. Your record uses ${lookupCount}/10 lookups — close to the limit. Adding another mail provider could break SPF delivery.`;
	}
	if (result === 'pass') return `SPF passed — the sending server is authorized by your DNS record.${lookupCount !== null ? ` Uses ${lookupCount}/10 DNS lookups.` : ''}`;
	if (result === 'softfail') return "SPF soft-failed (~all). Consider tightening to -all once you've verified all senders.";
	if (result === 'fail') return "SPF hard-failed. The sending server is not listed in your SPF record. Check you've included all mail providers.";
	return `SPF returned "${result}". Review your SPF record for syntax errors or missing includes.`;
}

export function dkimAdvice(result: string | null): string {
	if (!result || result === 'none') return 'No DKIM signature found. Configure DKIM signing in your email provider and add the public key to DNS.';
	if (result === 'pass') return 'DKIM passed — this email was cryptographically signed by your domain.';
	return "DKIM failed. The signature didn't match — check your private key is correctly configured in your mail provider.";
}

export function dmarcAdvice(result: string | null, policy: string | null, record: string | null): string {
	if (!record) return 'No DMARC record found. Add: _dmarc.yourdomain.com TXT "v=DMARC1; p=none; rua=mailto:rua@reports.yourdomain.com"';
	if (!result || result === 'none') return "DMARC record exists but couldn't evaluate alignment. Check SPF and DKIM are passing first.";
	if (result === 'pass' && policy === 'reject') return 'DMARC passed with p=reject — maximum protection enabled.';
	if (result === 'pass' && policy === 'quarantine') return "DMARC passed. Consider upgrading to p=reject for full protection once you're confident all legitimate mail passes.";
	if (result === 'pass' && policy === 'none') return "DMARC passed but policy is p=none — you're in monitoring mode. Upgrade to p=quarantine then p=reject when ready.";
	if (result === 'fail') return "DMARC failed — SPF or DKIM alignment isn't matching your From: domain. Check that your mail provider sends from the same domain.";
	return `DMARC result: ${result}. Policy: ${policy ?? 'none'}.`;
}

export type OverallStatus = CheckResult['overall_status'];
export const OVERALL: Record<OverallStatus, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
	protected: { label: 'Protected', variant: 'success' },
	at_risk: { label: 'At risk', variant: 'warning' },
	exposed: { label: 'Exposed', variant: 'danger' },
};
export const overallMeta = (status: string) => OVERALL[status as OverallStatus] ?? OVERALL.exposed;

// ── Audit log ──────────────────────────────────────────────────────────

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_FILTERS = [
	{ label: 'All', value: '' },
	{ label: 'Auth', value: 'auth.' },
	{ label: 'DNS', value: 'dns.' },
	{ label: 'Domains', value: 'domain.' },
	{ label: 'SPF', value: 'spf_flatten.' },
	{ label: 'MTA-STS', value: 'mta_sts.' },
	{ label: 'Team', value: 'team.' },
	{ label: 'Cron', value: 'cron.' },
] as const;

export type BadgeTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral' | 'outline';
const ACTION_TONE: Array<[string, BadgeTone]> = [
	['auth.', 'brand'],
	['domain.', 'success'],
	['dns.', 'warning'],
	['spf_flatten.', 'brand'],
	['mta_sts.', 'success'],
	['team.', 'warning'],
];
export function actionTone(action: string): BadgeTone {
	return ACTION_TONE.find(([prefix]) => action.startsWith(prefix))?.[1] ?? 'neutral';
}

/** Pretty-prints stored JSON; non-JSON strings are shown as they are. */
export function prettyJson(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

