/**
 * What the dashboard must say besides the numbers, as pure helpers over the server's fields (src/reports/visibility.ts):
 *
 *   report_counting  'known' | 'authenticated' | 'all': which stored reports feed the numbers on this page
 *   counting_note    why nothing can be counted right now (AUTHSERV_* not set while the mode needs authentication), or null
 *   unrecognised     stored reports from senders we do not recognise (authenticated but not a known reporter, or not authenticated), any mode
 *   uncounted        the part of `unrecognised` that is left out of the numbers in this mode (empty in 'all' mode)
 *   intake           mail that reached the report address and was not stored, and any limit currently in force
 *
 * They are on `GET /api/domains/:id/stats`, `/check-summary` and `/analytics`. A page that shows "no reports" (or a healthy rate)
 * must ask `emptyReportsState()` first: it never answers `none` while reports were left out or lost.
 * Three tiers decide what a report is (src/dmarc/reporter-auth.ts): counted (authenticated AND a known reporter), received but not
 * counted (authenticated, not known), refused (not authenticated: never stored, so never shown).
 */

export type ReportCounting = 'known' | 'authenticated' | 'all';
export type ReporterTier = 'counted' | 'unknown' | 'unauthenticated';

export interface UncountedInfo {
	reports: number;
	messages: number;
	latest_at: number | null;
	by_reporter: Array<{ reporter: string; reports: number }>;
}

export interface IntakeInfo {
	status: 'ok' | 'limited' | 'not_processed';
	limit: 'workspace_storage' | 'instance_storage' | 'address_day' | 'workspace_day' | null;
	notice: string | null;
	not_processed: { messages: number; last_at: number | null; reasons: Array<{ reason: string; messages: number; last_at: number; text: string }> };
}

/** The visibility fields, optional because older servers do not send them. */
export interface ReportVisibilityFields {
	report_counting?: ReportCounting;
	counting_note?: string | null;
	unrecognised?: UncountedInfo;
	uncounted?: UncountedInfo;
	intake?: IntakeInfo;
}

/** "3 reports from senders we do not recognise are not counted." — or null when nothing is left out. */
export function uncountedNotice(v: ReportVisibilityFields | null | undefined): string | null {
	const n = v?.uncounted?.reports ?? 0;
	if (n <= 0) return null;
	if (v?.report_counting === 'authenticated') return n === 1 ? '1 report from a sender that could not be authenticated is not counted.' : `${n} reports from senders that could not be authenticated are not counted.`;
	return n === 1 ? '1 report from a sender we do not recognise is not counted.' : `${n} reports from senders we do not recognise are not counted.`;
}

/** For a server that counts every report ('all'): how many counted reports come from senders we do not recognise. Null otherwise. */
export function unrecognisedCountedNotice(v: ReportVisibilityFields | null | undefined): string | null {
	const n = v?.unrecognised?.reports ?? 0;
	if (v?.report_counting !== 'all' || n <= 0) return null;
	return n === 1 ? '1 report is from a sender we do not recognise; it is counted because this server counts every report.' : `${n} reports are from senders we do not recognise; they are counted because this server counts every report.`;
}

/** The reporters behind the uncounted reports, e.g. "From evil.example (2), other.example (1)". Null when there are none. */
export function uncountedReporters(v: ReportVisibilityFields | null | undefined): string | null {
	const rows = v?.uncounted?.by_reporter ?? [];
	return rows.length ? `From ${rows.map((r) => `${r.reporter} (${r.reports})`).join(', ')}` : null;
}

/** Plain sentence for a storage limit or reports that could not be processed; null when all is well. */
export function intakeNotice(v: ReportVisibilityFields | null | undefined): string | null {
	return v?.intake?.notice ?? null;
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
	if (mode === 'known') return 'Only reports from known reporters are counted.';
	if (mode === 'authenticated') return 'Only reports from authenticated senders are counted.';
	if (mode === 'all') return 'Every stored report is counted, authenticated or not.';
	return null;
}

// ── instance owner: the unknown reporters list ───────────────

export interface UnknownReporterRow { reporter: string; reports: number; first_seen: number; last_seen: number }
export interface UnknownReportersResponse {
	reporters: UnknownReporterRow[];
	known: Array<{ org: string; kind: 'address' | 'domain'; value: string }>;
	issues: string[];
}

/** One line for the instance owner: "3 senders we do not recognise sent reports (12 in total); latest: x.example." Null when there are none. */
export function unknownReportersSummary(r: UnknownReportersResponse | null | undefined): string | null {
	const rows = r?.reporters ?? [];
	if (!rows.length) return null;
	const total = rows.reduce((n, x) => n + x.reports, 0);
	const latest = [...rows].sort((a, b) => b.last_seen - a.last_seen)[0].reporter;
	return `${rows.length} ${rows.length === 1 ? 'sender' : 'senders'} we do not recognise sent reports (${total} in total); latest: ${latest}.`;
}

/** The setting to paste to count a reporter: `address:dmarc@example.org`. The owner decides; nothing is added automatically. */
export const knownReporterSetting = (kind: 'address' | 'domain', value: string) => `INTAKE_KNOWN_REPORTERS=${kind}:${value.trim().toLowerCase()}`;
