import { describe, expect, it } from 'vitest';
import { domainActions, type ActionInput } from '../src/lib/actions';
import type { DnsCheck, OnboardingResult } from '../src/lib/domain-queries';
import { getStartedSteps } from '../src/lib/get-started';
import type { DomainCheckSummary } from '../src/lib/types';
import { domainVerdict, workspaceAnswer, type ReportTotals } from '../src/lib/verdict';

const now = Math.floor(Date.now() / 1000);
const domain = { id: 1, domain: 'example.com', rua_address: 'r@reports.test' };
const summary = (o: Partial<DomainCheckSummary> = {}): DomainCheckSummary => ({
	domain_id: 1, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok',
	dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0,
	spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, ...o,
});
const reports = (passRate: number | null, total = 1000): ReportTotals => ({ total: passRate === null ? 0 : total, passed: passRate === null ? 0 : Math.round((total * passRate) / 100), failed: 0, passRate, days: 7 });
const dns = (record: string | null, o: Partial<DnsCheck> = {}): DnsCheck => ({ found: !!record, has_rua: true, current_record: record, cf_managed: false, ...o });
const onboarding = (o: Partial<OnboardingResult> = {}): OnboardingResult => ({
	domain_id: 1, domain: 'example.com', rua_address: 'r@reports.test', cf_available: false,
	dmarc: { found: true, has_our_rua: true, current_record: null },
	spf: { record: 'v=spf1 include:_spf.google.com -all', lookup_count: 3, flattening_active: false },
	dkim: { selectors: [{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
	...o,
});
const input = (o: Partial<ActionInput> = {}): ActionInput => ({ domain, dns: dns('v=DMARC1; p=reject; rua=mailto:r@reports.test'), onboarding: onboarding(), summary: summary(), reports: reports(99), sources: [], ...o });
const keys = (o: Partial<ActionInput>) => domainActions(input(o)).map((a) => `${a.status}:${a.key}`);

describe('domainActions: Do this next', () => {
	it('a healthy enforced domain has nothing to do, and names what that covers', () => {
		const [a] = domainActions(input());
		expect(a).toMatchObject({ status: 'verified', do: 'Nothing to do', who: 'Nobody' });
		expect(a!.why).toBe('Nothing in public DNS and 1,000 reported messages needs a change right now.');
	});

	it('a lookup that failed is Unknown with a retry, and never "publish a record"', () => {
		expect(keys({ dns: dns(null, { error: 'timeout' }), onboarding: onboarding({ dns_errors: ['spf: timeout'] }) })).toEqual(['unknown:lookup']);
		const [a] = domainActions(input({ dns: null }));
		expect(a).toMatchObject({ status: 'unknown', retry: true });
		expect(a!.why).toMatch(/Nothing is assumed missing/);
	});

	it('orders by urgency and keeps at most three', () => {
		const k = keys({ dns: dns(null), onboarding: onboarding({ spf: { record: null, lookup_count: null, flattening_active: false }, dkim: { selectors: [], source: 'doh' } }), reports: reports(null) });
		expect(k).toEqual(['attention:spf-missing', 'attention:dmarc-missing', 'unknown:dkim-unknown']);
	});

	it('SPF over ten lookups needs attention and points at flattening', () => {
		const [a] = domainActions(input({ onboarding: onboarding({ spf: { record: 'v=spf1 include:a include:b ~all', lookup_count: 13, flattening_active: false } }) }));
		expect(a).toMatchObject({ key: 'spf-lookups', status: 'attention', to: '/domains/1/spf-flatten' });
		expect(a!.why).toMatch(/It needs 13/);
	});

	it('p=none with clean reports awaits approval; with failing senders it is worth fixing; with none it waits for reports', () => {
		const none = dns('v=DMARC1; p=none; rua=mailto:r@reports.test');
		expect(keys({ dns: none, reports: reports(97) })).toEqual(['approval:approve']);
		expect(keys({ dns: none, reports: reports(80), sources: [{ source_ip: '198.2.180.1', total: 40, header_from: 'example.com', base_domain: 'mcsv.net', org: 'Mailchimp' }] })).toEqual(['improve:senders']);
		expect(domainActions(input({ dns: none, reports: reports(80), sources: [{ source_ip: '198.2.180.1', total: 40, header_from: 'example.com', base_domain: 'mcsv.net', org: 'Mailchimp' }] }))[0]!.why).toMatch(/largest failing source is Mailchimp/);
		expect(keys({ dns: none, reports: reports(null) })).toEqual(['gathering:gathering']);
	});

	it('without a reports address, report-dependent advice is Unknown, never "gathering"', () => {
		const k = keys({ domain: { ...domain, rua_address: '' }, dns: dns('v=DMARC1; p=none'), reports: reports(null) });
		expect(k).toEqual(['unknown:no-reports']);
	});

	it('a record that does not send reports here says so', () => {
		expect(keys({ dns: dns('v=DMARC1; p=reject', { has_rua: false }) })).toContain('improve:dmarc-rua');
	});

	it('enforced mail mostly failing needs attention; partial pct is worth fixing', () => {
		expect(keys({ reports: reports(50) })).toEqual(['attention:senders']);
		expect(keys({ dns: dns('v=DMARC1; p=reject; pct=25; rua=mailto:r@reports.test') })).toEqual(['improve:pct']);
	});

	it('a subdomain covered by its parent is not told to publish its own DMARC', () => {
		const k = keys({ dns: dns(null), summary: summary({ dmarc_policy: 'reject', dmarc_inherited_from: 'example.org' }) });
		expect(k).not.toContain('attention:dmarc-missing');
		expect(k).toEqual(['verified:done']);
	});

	it('a domain that does not resolve gets one action', () => {
		expect(keys({ summary: summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }) })).toEqual(['attention:nxdomain']);
	});

	it('revoked DKIM keys need attention; selectors DNS cannot find are Unknown', () => {
		expect(keys({ onboarding: onboarding({ dkim: { selectors: [{ name: 's._domainkey.example.com', record: 'v=DKIM1; p=' }], source: 'doh' } }) })).toEqual(['attention:dkim-revoked']);
		expect(keys({ onboarding: onboarding({ dkim: { selectors: [], source: 'doh' } }) })).toEqual(['unknown:dkim-unknown']);
	});
});

describe('domainVerdict and workspaceAnswer', () => {
	it('names the scope: public DNS, then reports', () => {
		const v = domainVerdict(domain, summary(), reports(99));
		expect(v).toMatchObject({ status: 'verified', level: 2, checked: 'Checked 1 minute ago' });
		expect(v.evidence).toBe('99% of 1,000 reported messages passed DMARC in the last 7 days.');
		expect(workspaceAnswer([{ name: 'example.com', verdict: v }])).toBe('Done, from public DNS and reports: example.com is verified.');
	});

	it('quarantine with clean reports awaits approval for reject', () => {
		expect(domainVerdict(domain, summary({ dmarc_policy: 'quarantine' }), reports(96)).status).toBe('approval');
	});

	it('pending ownership proofs are part of the answer', () => {
		expect(workspaceAnswer([], 2)).toBe('Not yet: 2 domains are waiting for proof that they are yours.');
		const v = domainVerdict(domain, summary(), reports(99));
		expect(workspaceAnswer([{ name: 'example.com', verdict: v }], 1)).toBe('Done, from public DNS and reports: example.com is verified. 1 domain is waiting for proof that it is yours.');
	});

	it('says it is still checking until every row is known', () => {
		expect(workspaceAnswer([{ name: 'a.com', verdict: null }, { name: 'b.com', verdict: null }])).toBe('Checking where your 2 domains stand…');
	});
});

describe('getStartedSteps', () => {
	it('adds an ownership step only where ownership must be proven', () => {
		const base = { domains: [], claims: 0, summaries: [], verdicts: [], reports: [] };
		expect(getStartedSteps({ ...base, hosted: false }).map((s) => s.key)).toEqual(['add', 'read', 'publish']);
		expect(getStartedSteps({ ...base, hosted: true }).map((s) => s.key)).toEqual(['add', 'prove', 'read', 'publish']);
	});

	it('a step is done only when the data shows it', () => {
		const v = domainVerdict(domain, summary({ dmarc_policy: 'none' }), reports(null));
		const steps = getStartedSteps({ hosted: false, domains: [domain], claims: 0, summaries: [summary({ dmarc_policy: 'none' })], verdicts: [v], reports: [reports(null)] });
		expect(steps.map((s) => `${s.key}:${s.state}`)).toEqual(['add:done', 'read:done', 'publish:done', 'reports:waiting']);
	});
});

describe('slots for hosted help (PR 142)', () => {
	it('offers a help prompt only where a person may be stuck', () => {
		expect(domainVerdict(domain, summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }), reports(null)).help).toEqual({ lead: 'Sure this is the right name?', about: 'about example.com' });
		expect(domainVerdict(domain, summary({ dns_check_status: 'failed' }), reports(null)).help).toEqual({ lead: 'DNS checks keep failing?', about: 'about example.com' });
		expect(domainVerdict(domain, summary(), reports(99)).help).toBeNull();
	});

	it('reports-not-connected follows an empty report address', () => {
		expect(domainVerdict({ ...domain, rua_address: '' }, summary(), reports(null)).reportsNotConnected).toBe(true);
		expect(domainVerdict(domain, summary(), reports(null)).reportsNotConnected).toBe(false);
	});
});
