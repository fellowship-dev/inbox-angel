import { describe, expect, it } from 'vitest';
import { actionsPending, domainActions, type ActionInput } from '../src/lib/actions';
import { summaryFetchedAfterRead } from '../src/pages/domains/DomainDetailPage';
import type { DnsCheck, OnboardingResult } from '../src/lib/domain-queries';
import { getStartedSteps } from '../src/lib/get-started';
import type { DomainCheckSummary } from '../src/lib/types';
import { domainVerdict, workspaceAnswer, type ReportTotals } from '../src/lib/verdict';

const now = Math.floor(Date.now() / 1000);
const domain = { id: 1, domain: 'example.com', rua_address: 'r@reports.test' };
const summary = (o: Partial<DomainCheckSummary> = {}): DomainCheckSummary => ({
	domain_id: 1, domain: 'example.com', dmarc_policy: 'reject', spf_record: 'v=spf1 -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok',
	dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0,
	spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 3, dmarc_pct: 100, dmarc_sp: 'reject', ...o,
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
type Effective = NonNullable<OnboardingResult['dmarc']['effective']>;
const NO_POLICY: Effective = { policy: null, inherited_from: null, issue: null, record: null };
/** The live read: the onboarding DMARC block follows the dns-check answer unless a test gives its own. */
const input = (o: Partial<ActionInput> & { effective?: Effective | null } = {}): ActionInput => {
	const { effective, ...rest } = o;
	const d = 'dns' in o ? o.dns : dns('v=DMARC1; p=reject; rua=mailto:r@reports.test');
	const ob = 'onboarding' in o ? o.onboarding : onboarding({ dmarc: { found: !!d?.found, has_our_rua: true, current_record: d?.current_record ?? null, effective: effective === undefined ? NO_POLICY : effective } });
	return { domain, summary: summary(), reports: reports(99), sources: [], ...rest, dns: d, onboarding: ob };
};
const keys = (o: Parameters<typeof input>[0]) => domainActions(input(o)).map((a) => `${a.status}:${a.key}`);

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
		const k = keys({ dns: dns(null), onboarding: onboarding({ dmarc: { found: false, has_our_rua: false, current_record: null, effective: NO_POLICY }, spf: { record: null, lookup_count: null, flattening_active: false }, dkim: { selectors: [], source: 'doh' } }), reports: reports(null) });
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

	it('without a reports address, the step is connecting reports, never "gathering"', () => {
		const k = keys({ domain: { ...domain, rua_address: '' }, dns: dns('v=DMARC1; p=none'), reports: reports(null) });
		// Without a reports address, connecting reports is the step (one helper: "Connect reports" once PR 150 lands).
		expect(k).toEqual(['improve:connect-reports']);
	});

	it('a record that does not send reports here says so', () => {
		expect(keys({ dns: dns('v=DMARC1; p=reject', { has_rua: false }) })).toEqual(['verified:done', 'note:dmarc-rua']);
		expect(keys({ dns: dns('v=DMARC1; p=none', { has_rua: false }), reports: reports(null) })).toContain('improve:dmarc-rua');
	});

	it('enforced mail mostly failing needs attention; partial pct is worth fixing', () => {
		expect(keys({ reports: reports(50) })).toEqual(['attention:senders']);
		expect(keys({ dns: dns('v=DMARC1; p=reject; pct=25; rua=mailto:r@reports.test') })).toEqual(['improve:pct']);
	});

	it('a subdomain covered by its parent is not told to publish its own DMARC', () => {
		const k = keys({ dns: dns(null), effective: { policy: 'reject', inherited_from: 'example.org', issue: null, record: 'v=DMARC1; p=reject' } });
		expect(k).not.toContain('attention:dmarc-missing');
		expect(k).toEqual(['verified:done']);
	});

	it('a domain that does not resolve gets one action', () => {
		expect(keys({ summary: summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }) })).toEqual(['attention:nxdomain']);
	});

	it('revoked DKIM keys need attention; selectors DNS cannot find are Unknown', () => {
		expect(keys({ onboarding: onboarding({ dkim: { selectors: [{ name: 's._domainkey.example.com', record: 'v=DKIM1; p=' }], source: 'doh' } }) })).toEqual(['attention:dkim-revoked']);
		// With reports showing mail passing, a selector DNS cannot find is a note under "Nothing to do", not the lead.
		expect(keys({ onboarding: onboarding({ dkim: { selectors: [], source: 'doh' } }) })).toEqual(['verified:done', 'note:dkim-unknown']);
		expect(keys({ onboarding: onboarding({ dkim: { selectors: [], source: 'doh' } }), reports: reports(80) })).toEqual(['improve:senders', 'unknown:dkim-unknown']);
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
		expect(workspaceAnswer([{ name: 'example.com', verdict: v }], 1)).toBe('Not yet: example.com is verified (public DNS and reports), but 1 domain is waiting for proof that it is yours.');
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
		expect(domainVerdict(domain, summary({ dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }), reports(null)).help).toEqual({ lead: 'Sure this is the right name?', about: 'about example.com', priority: 50 });
		expect(domainVerdict(domain, summary({ dns_check_status: 'failed' }), reports(null)).help).toEqual({ lead: 'DNS checks keep failing?', about: 'about example.com', priority: 50 });
		expect(domainVerdict(domain, summary(), reports(99)).help).toBeNull();
	});

	it('reports-not-connected follows an empty report address', () => {
		expect(domainVerdict({ ...domain, rua_address: '' }, summary(), reports(null)).reportsNotConnected).toBe(true);
		expect(domainVerdict(domain, summary(), reports(null)).reportsNotConnected).toBe(false);
	});
});

// ── Truth table: every state the overview row can be in, and what the domain page's "Do this next" says for it ──
const ago = (d: number) => now - d * 86400;
type Row = [name: string, sum: Partial<DomainCheckSummary>, rep: ReportTotals | null, status: string, level: number | null, sentence: RegExp, next: string];
export const TRUTH: Row[] = [
	['reject, pct=100, reports pass', {}, reports(99), 'verified', 2, /p=reject, so mail that fails DMARC is rejected\.$/, 'Nothing to do'],
	['reject, no reports', {}, reports(null), 'verified', 2, /is rejected\.$/, 'Nothing to do'],
	['reject, report totals failed', {}, null, 'unknown', 2, /is rejected\.$/, 'Open the domain to load its reports'],
	['reject, pct=10', { dmarc_pct: 10 }, reports(99), 'improve', 2, /with pct=10, so only 10% of mail that fails DMARC is rejected/, 'Raise pct from 10 to 100'],
	['reject, sp=none (gov.uk)', { dmarc_sp: 'none' }, reports(99), 'improve', 2, /Subdomains without their own record follow sp=none, so failing mail from them is still delivered\./, 'Set sp=reject to enforce subdomains too'],
	['reject inherited, parent sp weaker is not this domain\'s problem', { dmarc_inherited_from: 'parent.com', dmarc_sp: 'none' }, reports(null), 'verified', 2, /inherited from parent\.com, so mail that fails DMARC is rejected/, 'Nothing to do'],
	['reject, pct and sp not read yet', { dmarc_pct: null, dmarc_sp: null }, reports(99), 'unknown', 2, /has not been read yet, so it is not called enforced/, 'Open the domain to read its DMARC record'],
	['reject, SPF over 10 lookups', { spf_lookup_count: 12 }, reports(99), 'attention', 2, /needs 12 DNS lookups/, 'Bring SPF down to 10 DNS lookups or fewer'],
	['reject, latest check failed after a good one', { dns_check_status: 'failed', dns_check_attempted_at: now - 60, dns_checked_at: ago(2) }, reports(99), 'unknown', 2, /^The latest DNS check failed\. At the last good check: public DNS shows/, 'Open the domain to check it again'],
	['reject, last good check 8 days old', { dns_checked_at: ago(8), dns_check_attempted_at: ago(8) }, reports(99), 'unknown', 2, /That was 8 days ago, so it may have changed\./, 'Open the domain to check it again'],
	['reject, 60% passing', {}, reports(60), 'attention', 2, /Only 60% of reported mail passes/, 'Fix the senders that fail DMARC'],
	['reject, 94.6% passing (not rounded up to 95)', {}, { total: 1000, passed: 946, failed: 54, passRate: 95, days: 30 }, 'improve', 2, /is rejected\.$/, 'Fix the senders that fail DMARC'],
	['quarantine, 92% passing', { dmarc_policy: 'quarantine', dmarc_sp: 'quarantine' }, reports(92), 'approval', 2, /quarantined, usually to spam/, 'Review your senders, then approve p=reject'],
	['quarantine, no reports', { dmarc_policy: 'quarantine', dmarc_sp: 'quarantine' }, reports(null), 'verified', 2, /quarantined/, 'Move to p=reject once reports confirm your senders'],
	['none, 97% passing', { dmarc_policy: 'none', dmarc_sp: 'none' }, reports(97), 'approval', 1, /p=none, so mail that fails DMARC is still delivered/, 'Review your senders, then approve p=quarantine'],
	['none, report totals failed', { dmarc_policy: 'none', dmarc_sp: 'none' }, null, 'improve', 1, /still delivered/, 'Open the domain to load its reports'],
	['none, no reports', { dmarc_policy: 'none', dmarc_sp: 'none' }, reports(null), 'improve', 1, /still delivered/, 'Make sure your DMARC record sends reports here'],
	['no DMARC record', { dmarc_policy: null, dmarc_sp: null, dmarc_pct: null }, reports(null), 'attention', 0, /SPF but no DMARC record/, 'Publish a DMARC record with p=none'],
	['several DMARC records', { dmarc_policy: null, dmarc_issue: 'multiple' }, reports(null), 'attention', 0, /several DMARC records/, 'Keep one DMARC record and delete the others'],
	['no SPF', { spf_record: null }, reports(null), 'attention', 0, /no SPF record/, 'Publish an SPF record'],
	['never checked', { dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null, spf_record: null, dmarc_policy: null }, reports(null), 'unknown', null, /Nothing has been read from DNS/, 'Open the domain to read its records from DNS'],
	['does not resolve', { dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }, reports(null), 'attention', null, /does not exist/, 'Check the spelling, or remove this domain'],
];

describe('truth table: overview row', () => {
	it.each(TRUTH)('%s', (_n, sum, rep, status, level, sentence, next) => {
		const v = domainVerdict(domain, summary(sum), rep, null, now);
		expect(v.status).toBe(status);
		expect(v.level).toBe(level);
		expect(v.sentence).toMatch(sentence);
		expect(v.next.label).toBe(next);
	});

	it('the workspace is Done only when every domain is Verified from a current check, and says what it rests on', () => {
		const ok = domainVerdict(domain, summary(), reports(99), null, now);
		const dnsOnly = domainVerdict(domain, summary(), reports(null), null, now);
		const partial = domainVerdict(domain, summary({ dmarc_pct: 10 }), reports(99), null, now);
		const failing = domainVerdict(domain, summary({ dns_check_status: 'failed', dns_checked_at: ago(1) }), reports(99), null, now);
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: ok }])).toBe('Done, from public DNS and reports: all 2 domains are verified.');
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: dnsOnly }])).toBe('Done, from public DNS only: all 2 domains are verified.');
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: partial }])).toMatch(/^Not yet\./);
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: failing }])).toMatch(/^Not yet\./);
		expect(workspaceAnswer([{ name: 'a.com', verdict: ok }, { name: 'b.com', verdict: ok }], 1)).toMatch(/^Not yet: all 2 domains are verified \(public DNS and reports\), but 1 domain is waiting/);
		expect(workspaceAnswer([{ name: 'a.com', verdict: domainVerdict(domain, summary(), null, null, now) }])).toMatch(/^Not yet/);
	});
});

describe('truth table: Do this next', () => {
	const sub = { ...domain, domain: 'mail.example.com' };
	const noOwn = dns(null);

	it('a subdomain with no record of its own is offered a DMARC record only when DNS shows no policy covers it (PR 142 dmarcCoverage)', () => {
		const k = (o: Parameters<typeof input>[0]) => keys({ domain: sub, dns: noOwn, ...o });
		expect(k({ effective: { policy: 'reject', inherited_from: 'example.com', issue: null, record: 'v=DMARC1; p=reject' } })).toEqual(['verified:done']);
		// The server could not say (null) or did not say (absent): unknown, and nothing is offered.
		for (const effective of [null, undefined]) {
			const ob = onboarding({ dmarc: { found: false, has_our_rua: false, current_record: null, effective } });
			const got = domainActions(input({ domain: sub, dns: noOwn, onboarding: ob }));
			expect(got.map((a) => a.key)).toEqual(['dmarc-coverage']);
			expect(got[0]!.status).toBe('unknown');
			expect(got.some((a) => /Publish a DMARC record/.test(a.do))).toBe(false);
		}
		// The DMARC lookup itself failed: unknown, nothing offered.
		const failed = onboarding({ dns_errors: ['dmarc: SERVFAIL'], dmarc: { found: false, has_our_rua: false, current_record: null, effective: NO_POLICY } });
		expect(domainActions(input({ domain: sub, dns: noOwn, onboarding: failed })).some((a) => a.key === 'dmarc-missing')).toBe(false);
		// Loading: nothing yet, and the page shows it is still reading.
		expect(domainActions(input({ domain: sub, dns: noOwn, onboarding: undefined }))).toEqual([]);
		expect(actionsPending({ dns: noOwn, onboarding: undefined, reports: reports(99) })).toBe(true);
		// Known absent: no own record and no parent policy. Only then is p=none offered.
		const missing = domainActions(input({ domain: sub, dns: noOwn, effective: NO_POLICY })).find((a) => a.key === 'dmarc-missing')!;
		expect(missing.do).toBe('Publish a DMARC record, starting at p=none');
		// Inherited quarantine at pct=5: nothing offered that would weaken or tighten it; the parent's pct is the fix.
		const partial = { policy: 'quarantine', inherited_from: 'example.com', issue: null, record: 'v=DMARC1; p=quarantine; pct=5' };
		expect(k({ effective: partial })).toEqual(['improve:parent-pct']);
		// The fix is at the parent, on its page when it is listed in this workspace.
		const pct = domainActions(input({ domain: sub, dns: noOwn, effective: { policy: 'reject', inherited_from: 'example.com', issue: null, record: 'v=DMARC1; p=reject; pct=10' }, parentId: 9 }));
		expect(pct.map((a) => a.key)).toEqual(['parent-pct']);
		expect(pct[0]).toMatchObject({ do: 'Raise pct from 10 to 100 at _dmarc.example.com', to: '/domains/9', cta: 'Open example.com' });
		// Inherited weaker sp: the subdomain follows sp=none while the parent itself rejects.
		const sp = domainActions(input({ domain: sub, dns: noOwn, effective: { policy: 'none', inherited_from: 'example.com', issue: null, record: 'v=DMARC1; p=reject; sp=none' }, parentId: 9 }));
		expect(sp.map((a) => a.key)).toEqual(['parent-sp']);
		expect(sp[0]).toMatchObject({ do: 'Set sp=reject at _dmarc.example.com', to: '/domains/9' });
		// Both: sp=quarantine at pct=10.
		const both = domainActions(input({ domain: sub, dns: noOwn, effective: { policy: 'quarantine', inherited_from: 'example.com', issue: null, record: 'v=DMARC1; p=reject; sp=quarantine; pct=10' } }));
		expect(both.map((a) => a.key).sort()).toEqual(['parent-pct', 'parent-sp']);
		expect(both.every((a) => a.to === undefined)).toBe(true); // parent not listed: no link to a page that is not there
		// Inherited p=none is never "nothing to do"; the fix is at the parent.
		expect(k({ effective: { policy: 'none', inherited_from: 'example.com', issue: null, record: 'v=DMARC1; p=none' } })).toEqual(['improve:parent-none']);
		// The parent's record gives no policy: fix it there.
		expect(k({ effective: { policy: null, inherited_from: 'example.com', issue: 'invalid', record: 'v=DMARC1; p=banana' } })).toEqual(['attention:dmarc-parent']);
	});

	it('p=none is never "nothing to do", whatever the report totals', () => {
		const none = dns('v=DMARC1; p=none; rua=mailto:r@reports.test');
		for (const r of [reports(99), reports(80), reports(null), null]) {
			const got = domainActions(input({ dns: none, reports: r }));
			expect(got.some((a) => a.key === 'done')).toBe(false);
		}
		expect(keys({ dns: none, reports: null })).toEqual(['unknown:reports-failed']);
		expect(actionsPending({ dns: none, onboarding: onboarding(), reports: undefined })).toBe(true);
	});

	it('enforced with report totals that failed to load is not "nothing to do"', () => {
		expect(keys({ reports: null })).toEqual(['unknown:reports-failed']);
	});

	it('weaker sp= on the domain page says subdomains are not enforced', () => {
		const got = domainActions(input({ dns: dns('v=DMARC1; p=reject; sp=none; rua=mailto:r@reports.test') }));
		expect(got.map((a) => `${a.status}:${a.key}`)).toEqual(['improve:sp']);
		expect(got[0]!.do).toBe('Set sp=reject to enforce subdomains too');
	});

	it('94.6% is not 95%: thresholds use the exact share', () => {
		const r = { total: 1000, passed: 946, failed: 54, passRate: 95, days: 7 };
		expect(keys({ dns: dns('v=DMARC1; p=none; rua=mailto:r@reports.test'), reports: r })).toEqual(['improve:senders']);
	});

	it('a DKIM wildcard is "Can\'t tell from public DNS", never "none of the common selectors"', () => {
		const got = domainActions(input({ reports: reports(80), onboarding: onboarding({ dkim: { selectors: [], source: 'doh', wildcard: true } }) }));
		const w = got.find((a) => a.key === 'dkim-wildcard')!;
		expect(w.status).toBe('unknown');
		expect(w.why).toMatch(/Can't tell from public DNS/);
		expect(got.some((a) => /common selectors/.test(a.why))).toBe(false);
	});

	it('revoked old keys next to a working one are a Note; attention only when no usable key exists', () => {
		const both = onboarding({ dkim: { selectors: [{ name: 'old._domainkey.example.com', record: 'v=DKIM1; p=' }, { name: 'new._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAAB' }], source: 'doh' } });
		expect(keys({ onboarding: both })).toEqual(['verified:done', 'note:dkim-old']);
		const cname = onboarding({ dkim: { selectors: [{ name: 'old._domainkey.example.com', record: 'v=DKIM1; p=' }, { name: 's1._domainkey.example.com', record: 's1.domainkey.u1.wl.sendgrid.net' }], source: 'doh' } });
		expect(keys({ onboarding: cname })).toEqual(['verified:done', 'note:dkim-old']);
	});
});

describe('review round 2', () => {
	it('quarantine without a reports address: connecting reports is the step, on both pages', () => {
		const noRua = { ...domain, rua_address: '' };
		const v = domainVerdict(noRua, summary({ dmarc_policy: 'quarantine', dmarc_sp: 'quarantine' }), reports(null), null, now);
		expect(v.status).toBe('verified');
		expect(v.next.label).toBe('Set up a reports address so senders can be confirmed');
		const k = keys({ domain: noRua, dns: dns('v=DMARC1; p=quarantine'), reports: reports(null) });
		expect(k).toContain('improve:connect-reports');
		expect(k).not.toContain('verified:done');
	});

	it('a reports address missing from a quarantine record is the step; at reject it is a note', () => {
		expect(keys({ dns: dns('v=DMARC1; p=quarantine', { has_rua: false }), reports: reports(null) })).toContain('improve:dmarc-rua');
		expect(keys({ dns: dns('v=DMARC1; p=reject', { has_rua: false }) })).toEqual(['verified:done', 'note:dmarc-rua']);
	});

	it('a last good check older than 7 days supports no advice: re-check first, whatever the status', () => {
		const old = summary({ dmarc_policy: 'none', dmarc_sp: 'none', dns_checked_at: now - 9 * 86400, dns_check_attempted_at: now - 9 * 86400 });
		const v = domainVerdict(domain, old, reports(97), null, now);
		expect(v.status).toBe('unknown'); // not "Awaiting your approval" on 9-day-old facts
		expect(v.sentence).toMatch(/That was 9 days ago, so it may have changed\./);
		expect(v.next.label).toBe('Open the domain to check it again');
		const attention = domainVerdict(domain, summary({ spf_record: null, dns_checked_at: now - 9 * 86400 }), reports(null), null, now);
		expect(attention.status).toBe('attention');
		expect(attention.next.label).toBe('Open the domain to check it again');
	});

	it('an inherited partial policy on the overview points at the parent, and its page when listed', () => {
		const sub = { ...domain, id: 2, domain: 'mail.example.com' };
		const s = summary({ domain: 'mail.example.com', dmarc_policy: 'reject', dmarc_inherited_from: 'example.com', dmarc_pct: 10, dmarc_sp: 'reject' });
		const v = domainVerdict(sub, s, reports(99), null, now, { idByName: new Map([['example.com', 1]]) });
		expect(v.status).toBe('improve');
		expect(v.next).toMatchObject({ label: 'Raise pct from 10 to 100 at _dmarc.example.com', to: '/domains/1' });
	});

	it('a summary fetched before the live read is not used (DMARC issue, does not resolve)', () => {
		const stale = summary({ dmarc_policy: null, dmarc_issue: 'multiple' });
		expect(keys({ summary: stale })).toContain('attention:dmarc-multiple');
		expect(keys({ summary: stale, summaryFresh: false })).not.toContain('attention:dmarc-multiple');
		expect(keys({ summary: summary({ dns_check_status: 'nxdomain' }), summaryFresh: false })).not.toContain('attention:nxdomain');
		expect(summaryFetchedAfterRead(1000, 2000)).toBe(false);
		expect(summaryFetchedAfterRead(2000, 2000)).toBe(true);
		expect(summaryFetchedAfterRead(500, 0)).toBe(true);
	});

	it('CNAME selectors (Microsoft 365 style) are usable keys: one revoked TXT key beside them is a note', () => {
		const ob = onboarding({ dkim: { selectors: [
			{ name: 'selector1._domainkey.example.com', record: 'selector1-example-com._domainkey.example.onmicrosoft.com' },
			{ name: 'old._domainkey.example.com', record: 'v=DKIM1; p=' },
		], source: 'doh' } });
		expect(keys({ onboarding: ob })).toEqual(['verified:done', 'note:dkim-old']);
	});
});

describe('getStartedSteps: a domain that does not resolve', () => {
	it('is work to do, not "not read yet"', () => {
		const ok = domainVerdict(domain, summary(), reports(null), null, now);
		const nx = { ...domain, id: 2, domain: 'nope.example' };
		const gone = domainVerdict(nx, summary({ domain: 'nope.example', dns_check_status: 'nxdomain', spf_record: null, dmarc_policy: null }), reports(null), null, now);
		const steps = getStartedSteps({ hosted: false, domains: [domain, nx], claims: 0, summaries: [summary(), summary()], verdicts: [ok, gone], reports: [reports(null), reports(null)] });
		const publish = steps.find((s) => s.key === 'publish')!;
		expect(publish).toMatchObject({ state: 'todo', detail: '1 of 2 domains publish both.', action: { label: 'Fix nope.example', to: '/domains/2/settings' } });
	});
});
