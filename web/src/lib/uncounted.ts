/**
 * What the dashboard must say besides the numbers, as pure helpers over the server's fields (src/reports/visibility.ts):
 *
 *   report_counting  'registry' | 'authenticated' | 'all': which stored reports feed the numbers on this page
 *   counting_note    why nothing can be counted right now (AUTHSERV_* not set while the mode needs authentication), or null
 *   unrecognised     stored reports from senders we do not recognise (authenticated but not a registry reporter, or not authenticated), any mode
 *   uncounted        the part of `unrecognised` that is left out of the numbers in this mode (empty in 'all' mode), split `unknown` / `unauthenticated`
 *   reporters        who the counted numbers come from: `attribution` ("from 12 reports by Google, Microsoft"), `counted[]`, `major` (Google or Microsoft counted)
 *   intake           mail that reached the report address and was not stored, and any limit currently in force
 *
 * They are on `GET /api/domains/:id/stats`, `/check-summary` and `/analytics`. A page that shows "no reports" (or a healthy rate)
 * must ask `emptyReportsState()` first: it never answers `none` while reports were left out or lost.
 * Three tiers decide what a report is (src/dmarc/reporter-auth.ts): counted (authenticated AND a registry reporter), received but not counted
 * (authenticated, not in the registry), received but not counted (not authenticated). Refused reports (malformed, not a report, not your domain) are never stored.
 */

export type ReportCounting = 'registry' | 'authenticated' | 'all';
export type ReporterTier = 'counted' | 'unknown' | 'unauthenticated';

export interface UncountedInfo {
	reports: number;
	messages: number;
	latest_at: number | null;
	unknown?: number;
	unauthenticated?: number;
	/** An unauthenticated sender is `unverified: true` with the org name it wrote only in `claims`. */
	by_reporter: Array<{ reporter: string; reports: number; unverified?: boolean; claims?: string | null }>;
}

export interface ReportersInfo {
	counted: Array<{ reporter: string; label: string; reports: number; messages: number }>;
	attribution: string | null;
	major: boolean;
}

export interface IntakeInfo {
	status: 'ok' | 'limited' | 'not_processed';
	limit: 'workspace_storage' | 'instance_storage' | 'address_day' | 'workspace_day' | 'counted_storage_dropped' | null;
	notice: string | null;
	/** Known reporters whose counted reports were not stored for want of storage; times are ISO 8601 (UTC). */
	dropped?: Array<{ reporter: string; label: string; since: string; last_at: string; messages: number; text: string }>;
	not_processed: { messages: number; last_at: number | null; reasons: Array<{ reason: string; messages: number; last_at: number; text: string }> };
}

/** The visibility fields, optional because older servers do not send them. */
export interface ReportVisibilityFields {
	report_counting?: ReportCounting;
	counting_note?: string | null;
	unrecognised?: UncountedInfo;
	uncounted?: UncountedInfo;
	reporters?: ReportersInfo;
	intake?: IntakeInfo;
}

/** "3 reports from senders we do not recognise are not counted." — or null when nothing is left out. Reports whose sender was not authenticated get their own sentence. */
export function uncountedNotice(v: ReportVisibilityFields | null | undefined): string | null {
	const u = v?.uncounted;
	const n = u?.reports ?? 0;
	if (!u || n <= 0) return null;
	const unauth = u.unauthenticated ?? 0;
	const unknown = u.unknown ?? n - unauth;
	const parts: string[] = [];
	if (unknown > 0) parts.push(unknown === 1 ? '1 report from a sender we do not recognise is not counted.' : `${unknown} reports from senders we do not recognise are not counted.`);
	if (unauth > 0) parts.push(unauth === 1 ? '1 report from a sender that could not be authenticated is not counted.' : `${unauth} reports from senders that could not be authenticated are not counted.`);
	return parts.join(' ') || null;
}

/** Who the counted numbers come from, e.g. "from 12 reports by Google, Microsoft" — every percentage on a page names this. Null when nothing is counted. */
export function countedReporters(v: ReportVisibilityFields | null | undefined): string | null {
	return v?.reporters?.attribution ?? null;
}

/** "Safe to enforce" advice needs a counted Google or Microsoft report; false is the reason to hold it back. */
export function hasMajorReporter(v: ReportVisibilityFields | null | undefined): boolean {
	return v?.reporters?.major === true;
}

/** For a server that counts every report ('all'): how many counted reports come from senders we do not recognise. Null otherwise. */
export function unrecognisedCountedNotice(v: ReportVisibilityFields | null | undefined): string | null {
	const n = v?.unrecognised?.reports ?? 0;
	if (v?.report_counting !== 'all' || n <= 0) return null;
	return n === 1 ? '1 report is from a sender we do not recognise; it is counted because this server counts every report.' : `${n} reports are from senders we do not recognise; they are counted because this server counts every report.`;
}

/**
 * The reporters behind the uncounted reports, e.g. "From evil.example (2), an unverified sender (claims to be google.com) (1)". A sender that
 * was not authenticated is never named by what it wrote: it is an unverified sender, and the name it gave is only what it claims. Null when none.
 */
export function uncountedReporters(v: ReportVisibilityFields | null | undefined): string | null {
	const rows = v?.uncounted?.by_reporter ?? [];
	const label = (r: (typeof rows)[number]) =>
		r.unverified ? `an unverified sender${r.claims ? ` (claims to be ${r.claims})` : ''} (${r.reports})` : `${r.reporter} (${r.reports})`;
	return rows.length ? `From ${rows.map(label).join(', ')}` : null;
}

/** A time the server sent as ISO 8601, in the user's locale and time zone (both default to the browser's). */
export function formatWhen(iso: string, opts: { locale?: string; timeZone?: string } = {}): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(opts.locale, { dateStyle: 'medium', timeStyle: 'short', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
}

/** "Report storage limit reached; reports from Google since 14 Nov 2026, 03:12 were not stored", the time in the user's locale and time zone. */
export function storageDropNotice(d: { label: string; since: string }, opts: { locale?: string; timeZone?: string } = {}): string {
	return `Report storage limit reached; reports from ${d.label} since ${formatWhen(d.since, opts)} were not stored`;
}

/** One sentence per reporter whose counted reports were not stored (empty when none). */
export function storageDropNotices(v: ReportVisibilityFields | null | undefined, opts: { locale?: string; timeZone?: string } = {}): string[] {
	return (v?.intake?.dropped ?? []).map((d) => storageDropNotice(d, opts));
}

/** Plain sentence for a storage limit or reports that could not be processed; null when all is well. Known reporters' dropped reports are named, with the time localised. */
export function intakeNotice(v: ReportVisibilityFields | null | undefined, opts: { locale?: string; timeZone?: string } = {}): string | null {
	const drops = storageDropNotices(v, opts);
	return drops.length ? drops.join('. ') : v?.intake?.notice ?? null;
}

/** Why a page that shows no counted numbers is empty. Never `none` while reports were left out or lost. */
export type EmptyReportsState = 'counted' | 'none' | 'only_unrecognised' | 'not_processed' | 'limited' | 'blocked';

export function emptyReportsState(totalCountedMessages: number, v: ReportVisibilityFields | null | undefined): EmptyReportsState {
	if (v?.intake?.status === 'limited') return 'limited';
	if (v?.intake?.status === 'not_processed' && totalCountedMessages === 0) return 'not_processed';
	if (totalCountedMessages > 0) return 'counted';
	if (v?.counting_note) return 'blocked';
	if ((v?.uncounted?.reports ?? 0) > 0) return 'only_unrecognised';
	return 'none';
}

/** The sentence for the empty state, or null for `counted`. `none` is the only state that may say there are no reports. */
export function emptyReportsMessage(totalCountedMessages: number, v: ReportVisibilityFields | null | undefined): string | null {
	switch (emptyReportsState(totalCountedMessages, v)) {
		case 'counted': return null;
		case 'limited': return intakeNotice(v);
		case 'not_processed': return intakeNotice(v);
		case 'blocked': return v?.counting_note ?? null;
		case 'only_unrecognised': return `No counted reports yet. ${uncountedNotice(v)}`;
		case 'none': return 'No reports yet.';
	}
}

/** How the report browser labels one report's sender. */
export function reporterLabel(r: { reporter_tier?: ReporterTier | null; reporter_known_as?: string | null; reporter_auth_domain?: string | null; org_name?: string }): string {
	if (r.reporter_tier === 'counted') return `Known reporter: ${r.reporter_known_as ?? r.reporter_auth_domain ?? r.org_name ?? 'unknown'}`;
	if (r.reporter_tier === 'unknown') return `Authenticated sender we do not recognise: ${r.reporter_auth_domain ?? 'unknown domain'}`;
	if (r.reporter_tier === 'unauthenticated') return 'Sender could not be authenticated';
	return 'Received before senders were checked';
}

/** The line under the report table: which reports the numbers on this page include. */
export function countingBasisNote(mode: ReportCounting | undefined): string | null {
	if (mode === 'registry') return 'Only reports from known reporters are counted.';
	if (mode === 'authenticated') return 'Only reports from authenticated senders are counted.';
	if (mode === 'all') return 'Every stored report is counted, authenticated or not.';
	return null;
}

// ── instance owner: reporter candidates ─────────────────────

export interface ReporterCandidate {
	dkim_org: string; from_domain: string; org_name: string | null; report_email: string | null;
	reports: number; workspaces: number; days: number; first_seen: string; last_seen: string;
}
export interface ReporterCandidatesResponse {
	candidates: ReporterCandidate[];
	registry: Array<{ id: string; label: string }>;
	issues: string[];
	since: string;
}

/** One line for the instance owner: "3 authenticated senders are not in the registry (12 reports in total); latest: x.example." Null when there are none. */
export function candidatesSummary(r: ReporterCandidatesResponse | null | undefined): string | null {
	const rows = r?.candidates ?? [];
	if (!rows.length) return null;
	const total = rows.reduce((n, x) => n + x.reports, 0);
	const latest = [...rows].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))[0]!.dkim_org;
	return `${rows.length} authenticated ${rows.length === 1 ? 'sender is' : 'senders are'} not in the registry (${total} ${total === 1 ? 'report' : 'reports'} in total); latest: ${latest}.`;
}
