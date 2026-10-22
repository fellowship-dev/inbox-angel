import { describe, expect, it } from 'vitest';
import { assessDomain } from '../src/lib/levels';

const base = { dmarc_policy: null, spf_record: null, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null };
const statuses = (a: ReturnType<typeof assessDomain>) => a.findings.map((f) => f.status);

describe('assessDomain', () => {
	it('is level 0 with nothing published and asks for SPF first', () => {
		const a = assessDomain(base);
		expect(a.level).toBe(0);
		expect(a.next).toBe('Publish an SPF record.');
		expect(statuses(a)).toEqual(['missing', 'missing']);
	});

	it('stays at level 0 with SPF but no DMARC', () => {
		const a = assessDomain({ ...base, spf_record: 'v=spf1 -all' });
		expect(a.level).toBe(0);
		expect(a.next).toContain('DMARC record with p=none');
	});

	it('is level 1 with SPF and monitoring-only DMARC', () => {
		const a = assessDomain({ ...base, spf_record: 'v=spf1 -all', dmarc_policy: 'none' });
		expect(a.level).toBe(1);
		expect(a.findings.find((f) => f.status === 'warn')?.label).toContain('p=none');
		expect(a.next).toContain('quarantine');
	});

	it.each(['quarantine', 'reject'])('is level 2 when DMARC enforces p=%s on top of SPF', (policy) => {
		const a = assessDomain({ ...base, spf_record: 'v=spf1 -all', dmarc_policy: policy });
		expect(a.level).toBe(2);
		expect(a.next).toBeNull();
	});

	it('does not reach level 2 on DMARC alone, without SPF', () => {
		expect(assessDomain({ ...base, dmarc_policy: 'reject' }).level).toBe(0);
	});

	it('reports DKIM health and MTA-STS only when there is something to say', () => {
		const ok = assessDomain({ ...base, spf_record: 'v=spf1 -all', dmarc_policy: 'reject', dkim_total: 100, dkim_pass: 96, mta_sts_enabled: 1, mta_sts_mode: 'enforce' });
		expect(ok.findings.map((f) => f.label)).toContain('MTA-STS enforce');
		expect(statuses(ok).every((s) => s === 'pass')).toBe(true);
		const bad = assessDomain({ ...base, spf_record: 'v=spf1 -all', dmarc_policy: 'reject', dkim_total: 100, dkim_pass: 50 });
		expect(statuses(bad)).toContain('warn');
		expect(assessDomain({ ...base, spf_record: 'v=spf1 -all' }).findings).toHaveLength(2);
	});
});
