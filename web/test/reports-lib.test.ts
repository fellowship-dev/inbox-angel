import { describe, expect, it } from 'vitest';
import {
	actionTone,
	dkimAdvice,
	dmarcAdvice,
	explain,
	isActive,
	isoDay,
	passRate,
	prettyJson,
	protocolStatus,
	relativeTime,
	serviceVia,
	spfAdvice,
	spfStatus,
	splitActive,
	type AuthSource,
} from '../src/lib/reports';

const src = (over: Partial<AuthSource> = {}): AuthSource => ({
	source_ip: '1.2.3.4',
	header_from: 'example.com',
	spf_domain: null,
	dkim_domain: null,
	spf_pass: 0,
	dkim_pass: 0,
	base_domain: null,
	org: null,
	...over,
});

describe('explain', () => {
	it('says unauthorized when both fail', () => {
		expect(explain(src())).toContain('has no authorization to send as "example.com"');
		expect(explain(src())).toContain('this server');
	});
	it('names the include to add when only SPF fails', () => {
		expect(explain(src({ spf_pass: 0, dkim_pass: 1, spf_domain: 'mailchimp.com' }))).toContain('Add include:mailchimp.com to your SPF record.');
		expect(explain(src({ dkim_pass: 1 }))).toContain('Add this server to your SPF record.');
	});
	it('asks for DKIM when only DKIM fails', () => {
		expect(explain(src({ spf_pass: 1, dkim_pass: 0, dkim_domain: 'sendgrid.net' }))).toMatch(/^sendgrid\.net sent mail without a valid DKIM signature/);
	});
	it('falls back to "your domain" without a From', () => {
		expect(explain(src({ header_from: null }))).toContain('send as your domain');
	});
});

describe('serviceVia', () => {
	it('is null when the auth domain equals the From domain', () => {
		expect(serviceVia({ header_from: 'a.com', spf_domain: 'a.com', dkim_domain: null })).toBeNull();
		expect(serviceVia({ header_from: 'a.com', spf_domain: null, dkim_domain: 'b.com' })).toBe('b.com');
	});
});

describe('active / older split', () => {
	const now = new Date('2026-10-22T12:00:00Z');
	it('treats the last two days as active', () => {
		expect(isActive('2026-10-21', now)).toBe(true);
		expect(isActive('2026-10-19', now)).toBe(false);
		expect(isActive('2026-10-10', now)).toBe(false);
		const { active, older } = splitActive([{ last_seen: '2026-10-22' }, { last_seen: '2026-09-01' }], now);
		expect(active).toHaveLength(1);
		expect(older).toHaveLength(1);
	});
});

describe('email check advice', () => {
	it('maps results to statuses', () => {
		expect(protocolStatus(null)).toBe('missing');
		expect(protocolStatus('none')).toBe('missing');
		expect(protocolStatus('pass')).toBe('pass');
		expect(protocolStatus('softfail')).toBe('warn');
		expect(protocolStatus('permerror')).toBe('fail');
		expect(spfStatus('pass', 9)).toBe('warn');
		expect(spfStatus('pass', 3)).toBe('pass');
	});
	it('covers the SPF branches', () => {
		expect(spfAdvice(null, null)).toMatch(/^No SPF record found/);
		expect(spfAdvice('permerror', 12)).toContain('requires 12 DNS lookups');
		expect(spfAdvice('pass', 10)).toContain('at or over the limit');
		expect(spfAdvice('pass', 8)).toContain('close to the limit');
		expect(spfAdvice('pass', 3)).toContain('Uses 3/10 DNS lookups.');
		expect(spfAdvice('softfail', null)).toContain('soft-failed');
		expect(spfAdvice('fail', null)).toContain('hard-failed');
		expect(spfAdvice('temperror', null)).toContain('"temperror"');
	});
	it('covers DKIM and DMARC branches', () => {
		expect(dkimAdvice(null)).toContain('No DKIM signature');
		expect(dkimAdvice('fail')).toContain('DKIM failed');
		expect(dmarcAdvice(null, null, null)).toContain('No DMARC record');
		expect(dmarcAdvice('none', null, 'v=DMARC1')).toContain("couldn't evaluate");
		expect(dmarcAdvice('pass', 'reject', 'v=DMARC1')).toContain('maximum protection');
		expect(dmarcAdvice('pass', 'quarantine', 'v=DMARC1')).toContain('upgrading to p=reject');
		expect(dmarcAdvice('pass', 'none', 'v=DMARC1')).toContain('monitoring mode');
		expect(dmarcAdvice('fail', 'none', 'v=DMARC1')).toContain('DMARC failed');
		expect(dmarcAdvice('weird', null, 'v=DMARC1')).toBe('DMARC result: weird. Policy: none.');
	});
});

describe('formatting', () => {
	it('computes ISO days in UTC and pass rates', () => {
		expect(isoDay(1_760_000_000)).toBe('2025-10-09');
		expect(passRate(1, 4)).toBe(25);
		expect(passRate(0, 0)).toBeNull();
	});
	it('relative time', () => {
		const now = Date.parse('2026-10-22T12:00:00Z');
		expect(relativeTime(now / 1000 - 30, now)).toBe('just now');
		expect(relativeTime(now / 1000 - 3 * 3600, now)).toBe('3h ago');
		expect(relativeTime(now / 1000 - 2 * 86400, now)).toBe('2d ago');
	});
	it('audit helpers', () => {
		expect(actionTone('dns.record_added')).toBe('warning');
		expect(actionTone('mystery')).toBe('neutral');
		expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyJson('not json')).toBe('not json');
	});
});
