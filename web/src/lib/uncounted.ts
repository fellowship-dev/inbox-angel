/**
 * What the dashboard must say besides the numbers, as pure helpers over the server's fields (src/reports/visibility.ts):
 *
 *   report_counting  'proven' | 'all': which stored reports feed the numbers on this page
 *   unverified       stored reports whose sender the receiver could not verify (any mode)
 *   uncounted        the part of `unverified` that is left out of the numbers (empty in 'all' mode)
 *   intake           mail that reached the report address and was not stored, and any limit currently in force
 *
 * They are on `GET /api/domains/:id/stats`, `/check-summary` and `/analytics`. A page that shows "no reports" (or a healthy rate)
 * must ask `emptyReportsState()` first: it never answers `none` while reports were received and left out or lost.
 */

export type ReportCounting = 'proven' | 'all';

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
	unverified?: UncountedInfo;
	uncounted?: UncountedInfo;
	intake?: IntakeInfo;
}

/** "3 reports from senders we could not verify are not counted." — or null when nothing is left out. */
export function uncountedNotice(v: ReportVisibilityFields | null | undefined): string | null {
	const n = v?.uncounted?.reports ?? 0;
	if (n <= 0) return null;
	return n === 1 ? '1 report from a sender we could not verify is not counted.' : `${n} reports from senders we could not verify are not counted.`;
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
export type EmptyReportsState = 'counted' | 'none' | 'only_unverified' | 'not_processed' | 'limited';

export function emptyReportsState(totalCountedMessages: number, v: ReportVisibilityFields | null | undefined): EmptyReportsState {
	if (v?.intake?.status === 'limited') return 'limited';
	if (v?.intake?.status === 'not_processed' && totalCountedMessages === 0) return 'not_processed';
	if (totalCountedMessages > 0) return 'counted';
	if ((v?.uncounted?.reports ?? 0) > 0) return 'only_unverified';
	return 'none';
}

/** The sentence for the empty state, or null for `counted`. `none` is the only state that may say there are no reports. */
export function emptyReportsMessage(totalCountedMessages: number, v: ReportVisibilityFields | null | undefined): string | null {
	switch (emptyReportsState(totalCountedMessages, v)) {
		case 'counted': return null;
		case 'limited': return intakeNotice(v);
		case 'not_processed': return intakeNotice(v);
		case 'only_unverified': return `No counted reports yet. ${uncountedNotice(v)}`;
		case 'none': return 'No reports yet.';
	}
}

/** How the report browser labels one report's sender: "from google.com", or why it is not counted. */
export function reporterLabel(r: { reporter_auth?: 'pass' | 'fail' | 'none' | null; reporter_auth_domain?: string | null; org_name?: string; counted?: boolean }): string {
	const who = r.reporter_auth_domain ?? r.org_name ?? 'unknown sender';
	if (r.reporter_auth === 'pass') return `Verified sender: ${who}`;
	if (r.reporter_auth === 'fail') return `Sender could not be verified as ${who}`;
	if (r.reporter_auth === 'none') return 'Sender not verified (this server cannot verify senders yet)';
	return 'Received before senders were verified';
}

/** The line under the report table: whether the numbers on this page include unverified reports. */
export function countingBasisNote(mode: ReportCounting | undefined): string | null {
	if (mode === 'proven') return 'Only reports from verified senders are counted.';
	if (mode === 'all') return 'Every stored report is counted, verified or not.';
	return null;
}
