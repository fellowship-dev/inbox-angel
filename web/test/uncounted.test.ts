import { describe, expect, it } from 'vitest';
import { countingBasisNote, emptyReportsMessage, emptyReportsState, intakeNotice, reporterLabel, uncountedNotice, uncountedReporters, type ReportVisibilityFields } from '../src/lib/uncounted';

const none = { reports: 0, messages: 0, latest_at: null, by_reporter: [] };
const intakeOk = { status: 'ok' as const, limit: null, notice: null, not_processed: { messages: 0, last_at: null, reasons: [] } };
const v = (o: Partial<ReportVisibilityFields>): ReportVisibilityFields => ({ report_counting: 'proven', uncounted: none, unverified: none, intake: intakeOk, ...o });

describe('uncountedNotice', () => {
	it('says plainly how many reports are left out', () => {
		expect(uncountedNotice(v({ uncounted: { ...none, reports: 3 } }))).toBe('3 reports from senders we could not verify are not counted.');
		expect(uncountedNotice(v({ uncounted: { ...none, reports: 1 } }))).toBe('1 report from a sender we could not verify is not counted.');
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
		expect(emptyReportsState(0, x)).toBe('only_unverified');
		expect(emptyReportsMessage(0, x)).toBe('No counted reports yet. 2 reports from senders we could not verify are not counted.');
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
	it('reporterLabel says who the sender was verified as', () => {
		expect(reporterLabel({ reporter_auth: 'pass', reporter_auth_domain: 'google.com' })).toBe('Verified sender: google.com');
		expect(reporterLabel({ reporter_auth: 'fail', reporter_auth_domain: 'google.com' })).toBe('Sender could not be verified as google.com');
		expect(reporterLabel({ reporter_auth: 'none', org_name: 'x.example' })).toBe('Sender not verified (this server cannot verify senders yet)');
		expect(reporterLabel({ reporter_auth: null })).toBe('Received before senders were verified');
	});
	it('countingBasisNote', () => {
		expect(countingBasisNote('proven')).toBe('Only reports from verified senders are counted.');
		expect(countingBasisNote('all')).toBe('Every stored report is counted, verified or not.');
		expect(countingBasisNote(undefined)).toBeNull();
	});
});
