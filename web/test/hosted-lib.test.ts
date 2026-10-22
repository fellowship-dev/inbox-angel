import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { POINTER_STATE_LABEL, PURPOSE_LABEL, hostedError, pointerStateLabel } from '../src/lib/hosted';
import { applyHostedInputs, assessDomain, assessHostedDomain, type HostedLevelInput } from '../src/lib/levels';

const base = { dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null };
const hosted = (over: Partial<HostedLevelInput> = {}): HostedLevelInput => ({
	mta_sts: false,
	pointer_status: { dmarc: 'ok', spf: 'ok', mta_sts: null },
	level_inputs: { dmarc_published: true, spf_published: true, mta_sts_published: false },
	...over,
});

describe('hostedError', () => {
	it.each([
		[409, 'conflict', false],
		[422, 'input', false],
		[502, 'dns', true],
		[507, 'full', false],
	] as const)('maps %s to %s (retryable: %s) and keeps the server message', (status, kind, retryable) => {
		const r = hostedError(new ApiError(status, 'server said this'));
		expect(r).toMatchObject({ kind, retryable, message: 'server said this' });
		expect(r.title).not.toBe('');
	});
	it('treats network failures as retryable and other 4xx as not', () => {
		expect(hostedError(new Error('offline')).retryable).toBe(true);
		expect(hostedError(new ApiError(403, 'no')).retryable).toBe(false);
		expect(hostedError('weird').message).toBe('Something went wrong.');
	});
});

describe('labels', () => {
	it('names purposes', () => {
		expect(PURPOSE_LABEL).toEqual({ dmarc: 'DMARC', spf: 'SPF', tls_rpt: 'TLS-RPT', mta_sts: 'MTA-STS' });
	});
	it('reads a failed lookup as "Lookup failed", never "missing"', () => {
		expect(POINTER_STATE_LABEL.error).toBe('Lookup failed');
		expect(pointerStateLabel('error')).toBe('Lookup failed');
		expect(pointerStateLabel('error').toLowerCase()).not.toContain('missing');
		expect(pointerStateLabel(null)).toBe('Not checked yet');
		expect(pointerStateLabel('wrong')).toBe('Wrong value');
	});
});

describe('applyHostedInputs', () => {
	it('counts verified hosted records as published, even when the stored summary has none', () => {
		const { summary, unverified } = applyHostedInputs({ ...base, spf_record: null, dmarc_policy: null }, hosted());
		expect(summary.spf_record).toBeTruthy();
		expect(summary.dmarc_policy).toBe('none');
		expect(unverified).toEqual([]);
	});
	it('does not count a record whose pointer is not ok', () => {
		for (const state of ['missing', 'wrong', 'error', null] as const) {
			const { summary, unverified } = applyHostedInputs(base, hosted({ pointer_status: { dmarc: state, spf: 'ok', mta_sts: null } }));
			expect(summary.dmarc_policy).toBeNull();
			expect(unverified).toEqual(['dmarc']);
		}
	});
	it('does not count a record that level_inputs says is unpublished', () => {
		const { summary } = applyHostedInputs(base, hosted({ level_inputs: { dmarc_published: true, spf_published: false, mta_sts_published: false } }));
		expect(summary.spf_record).toBeNull();
	});
	it('only asks for an MTA-STS pointer when MTA-STS is hosted', () => {
		expect(applyHostedInputs(base, hosted()).unverified).toEqual([]);
		expect(applyHostedInputs(base, hosted({ mta_sts: true })).unverified).toEqual(['mta_sts']);
		const ok = applyHostedInputs(base, hosted({ mta_sts: true, pointer_status: { dmarc: 'ok', spf: 'ok', mta_sts: 'ok' }, level_inputs: { dmarc_published: true, spf_published: true, mta_sts_published: true } }));
		expect(ok.summary.mta_sts_enabled).toBe(1);
	});
});

describe('assessHostedDomain', () => {
	it('is level 2 when everything is published and verified', () => {
		expect(assessHostedDomain({ ...base, spf_record: null, dmarc_policy: 'reject' }, hosted()).level).toBe(2);
	});
	it('drops the level and explains "pointer not verified yet"', () => {
		const a = assessHostedDomain(base, hosted({ pointer_status: { dmarc: 'missing', spf: 'ok', mta_sts: null } }));
		expect(a.level).toBe(0);
		expect(a.findings.map((f) => f.label)).toContain('DMARC pointer not verified yet');
	});
	it('leaves the unhosted assessment untouched', () => {
		expect(assessDomain(base).level).toBe(2);
	});
});
