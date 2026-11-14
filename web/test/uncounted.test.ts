import { describe, expect, it } from 'vitest';
import { candidatesSummary, countedReporters, hasMajorReporter, countingBasisNote, emptyReportsMessage, emptyReportsState, intakeNotice, reporterLabel, storageDropNotice, storageDropNotices, uncountedNotice, uncountedReporters, type ReportVisibilityFields } from '../src/lib/uncounted';

const none = { reports: 0, messages: 0, latest_at: null, by_reporter: [] };
const intakeOk = { status: 'ok' as const, limit: null, notice: null, not_processed: { messages: 0, last_at: null, reasons: [] } };
const v = (o: Partial<ReportVisibilityFields>): ReportVisibilityFields => ({ report_counting: 'registry', uncounted: none, unrecognised: none, intake: intakeOk, ...o });

describe('uncountedNotice', () => {
	it('says plainly how many reports are left out', () => {
		expect(uncountedNotice(v({ uncounted: { ...none, reports: 3 } }))).toBe('3 reports from senders we do not recognise are not counted.');
		expect(uncountedNotice(v({ uncounted: { ...none, reports: 1 } }))).toBe('1 report from a sender we do not recognise is not counted.');
		expect(uncountedNotice(v({ uncounted: { ...none, reports: 3, unknown: 2, unauthenticated: 1 } }))).toBe('2 reports from senders we do not recognise are not counted. 1 report from a sender that could not be authenticated is not counted.');
	});
	it('says nothing when nothing is left out, or the server sent nothing', () => {
		expect(uncountedNotice(v({}))).toBeNull();
		expect(uncountedNotice(undefined)).toBeNull();
		expect(uncountedNotice({})).toBeNull();
	});
	it('names the reporters behind them', () => {
		expect(uncountedReporters(v({ uncounted: { ...none, reports: 3, by_reporter: [{ reporter: 'evil.example', reports: 2 }, { reporter: 'x.example', reports: 1 }] } }))).toBe('From evil.example (2), x.example (1)');
		expect(uncountedReporters(v({}))).toBeNull();
	});
});

describe('emptyReportsState: never "no reports" while reports were left out or lost', () => {
	it('none only when really nothing arrived', () => {
		expect(emptyReportsState(0, v({}))).toBe('none');
		expect(emptyReportsMessage(0, v({}))).toBe('No reports yet.');
		expect(emptyReportsState(0, undefined)).toBe('none');
	});
	it('only unverified reports arrived', () => {
		const x = v({ uncounted: { ...none, reports: 2 } });
		expect(emptyReportsState(0, x)).toBe('only_unrecognised');
		expect(emptyReportsMessage(0, x)).toBe('No counted reports yet. 2 reports from senders we do not recognise are not counted.');
	});
	it('reports that could not be processed are shown instead of "no reports"', () => {
		const x = v({ intake: { ...intakeOk, status: 'not_processed', notice: '2 reports received for this domain could not be processed', not_processed: { messages: 2, last_at: 5, reasons: [] } } });
		expect(emptyReportsState(0, x)).toBe('not_processed');
		expect(emptyReportsMessage(0, x)).toBe('2 reports received for this domain could not be processed');
		expect(intakeNotice(x)).toBe('2 reports received for this domain could not be processed');
		// with counted reports present the numbers show, and the notice is still available beside them
		expect(emptyReportsState(10, x)).toBe('counted');
	});
	it('a storage limit is always shown', () => {
		const x = v({ intake: { ...intakeOk, status: 'limited', limit: 'workspace_storage', notice: 'Report storage limit reached; newer reports are not being stored' } });
		expect(emptyReportsState(500, x)).toBe('limited');
		expect(emptyReportsMessage(0, x)).toBe('Report storage limit reached; newer reports are not being stored');
	});
	it('counted numbers show normally', () => {
		expect(emptyReportsState(10, v({}))).toBe('counted');
		expect(emptyReportsMessage(10, v({}))).toBeNull();
	});
});

describe('labels', () => {
	it('reporterLabel says what the tier decided', () => {
		expect(reporterLabel({ reporter_tier: 'counted', reporter_known_as: 'Google' })).toBe('Known reporter: Google');
		expect(reporterLabel({ reporter_tier: 'unknown', reporter_auth_domain: 'x.example' })).toBe('Authenticated sender we do not recognise: x.example');
		expect(reporterLabel({ reporter_tier: 'unauthenticated' })).toBe('Sender could not be authenticated');
		expect(reporterLabel({ reporter_tier: null })).toBe('Received before senders were checked');
	});
	it('countingBasisNote', () => {
		expect(countingBasisNote('registry')).toBe('Only reports from known reporters are counted.');
		expect(countingBasisNote('all')).toBe('Every stored report is counted, authenticated or not.');
		expect(countingBasisNote(undefined)).toBeNull();
	});
	it('names the reporters behind every percentage, and whether a major receiver is among them', () => {
		const x = v({ reporters: { counted: [], attribution: 'from 12 reports by Google, Microsoft', major: true } });
		expect(countedReporters(x)).toBe('from 12 reports by Google, Microsoft');
		expect(hasMajorReporter(x)).toBe(true);
		expect(countedReporters(v({}))).toBeNull();
		expect(hasMajorReporter(v({}))).toBe(false);
	});
	it('candidatesSummary', () => {
		const c = (dkim_org: string, reports: number, last_seen: string) => ({ dkim_org, from_domain: dkim_org, org_name: null, report_email: null, reports, workspaces: 1, days: 1, first_seen: last_seen, last_seen });
		expect(candidatesSummary({ candidates: [c('a.example', 2, '2026-11-01'), c('b.example', 1, '2026-11-03')], registry: [], issues: [], since: '' })).toBe('2 authenticated senders are not in the registry (3 reports in total); latest: b.example.');
		expect(candidatesSummary({ candidates: [], registry: [], issues: [], since: '' })).toBeNull();
	});
});

describe('counted reports dropped for want of storage (the server sends ISO times; the web renders them)', () => {
	// newer ICU writes a narrow no-break space before AM/PM
	const one = (t: string) => t.replace(/\u202f/g, ' ');
	const sp = <T extends string | string[]>(t: T): T => (Array.isArray(t) ? t.map(one) : one(t as string)) as T;
	const dropped = { reporter: 'google', label: 'Google', since: '2026-11-14T03:12:00.000Z', last_at: '2026-11-14T05:00:00.000Z', messages: 2, text: 'server text (UTC)' };
	const v = { intake: { status: 'limited' as const, limit: 'counted_storage_dropped' as const, notice: 'server text (UTC)', not_processed: { messages: 0, last_at: null, reasons: [] }, dropped: [dropped] } };

	it('renders the time in the user\'s locale and time zone', () => {
		expect(sp(storageDropNotice(dropped, { locale: 'en-US', timeZone: 'America/Los_Angeles' }))).toBe('Report storage limit reached; reports from Google since Nov 13, 2026, 7:12 PM were not stored');
		expect(storageDropNotice(dropped, { locale: 'en-GB', timeZone: 'Pacific/Auckland' })).toBe('Report storage limit reached; reports from Google since 14 Nov 2026, 16:12 were not stored');
	});
	it('names every reporter, and intakeNotice prefers it to the server\'s UTC text', () => {
		const two = { intake: { ...v.intake, dropped: [dropped, { ...dropped, reporter: 'microsoft', label: 'Microsoft', since: '2026-11-15T00:00:00.000Z' }] } };
		expect(sp(storageDropNotices(two, { locale: 'en-US', timeZone: 'UTC' }))).toEqual([
			'Report storage limit reached; reports from Google since Nov 14, 2026, 3:12 AM were not stored',
			'Report storage limit reached; reports from Microsoft since Nov 15, 2026, 12:00 AM were not stored',
		]);
		expect(sp(intakeNotice(v, { locale: 'en-US', timeZone: 'UTC' })!)).toBe('Report storage limit reached; reports from Google since Nov 14, 2026, 3:12 AM were not stored');
		expect(intakeNotice({ intake: { ...v.intake, dropped: [] } })).toBe('server text (UTC)');
		expect(storageDropNotices(undefined)).toEqual([]);
	});
	it('an unreadable time is shown as sent, never as "Invalid Date"', () => {
		expect(storageDropNotice({ label: 'Google', since: 'soon' })).toBe('Report storage limit reached; reports from Google since soon were not stored');
	});
	it('a drop is never "no reports": the empty state is limited', () => {
		expect(emptyReportsState(0, v)).toBe('limited');
	});
});
