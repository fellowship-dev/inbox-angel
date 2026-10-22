import { describe, expect, it } from 'vitest';
import { buildRecommendedRecord, parseDmarcPolicy } from '../src/lib/dmarc-record';
import { SPF_PROVIDERS, detectProviders, findUnsignedSpfProviders, getAllDkimSelectors, matchDkimProvider } from '@inbox-angel/dns-checks/email-service-providers';
import { buildSpfRecord, existingQualifier, extractIncludes, extractOtherMechanisms, lookupLevel, normalizeCustomInclude } from '@inbox-angel/dns-checks/spf-record';
import { DEFAULT_WIZARD, dnsErrorsFor, resolveStep, routingSeverity, spfSeverity, dkimSeverity } from '../src/pages/wizards/setup/steps';

describe('spf.ts', () => {
	const record = 'v=spf1 include:_spf.google.com include:custom.example.net mx ip4:203.0.113.0/24 redirect=other.example -all';

	it('extracts every include, known or not', () => {
		expect(extractIncludes(record)).toEqual(['_spf.google.com', 'custom.example.net']);
	});

	it('keeps non-include mechanisms and drops the all qualifier', () => {
		expect(extractOtherMechanisms(record)).toEqual(['mx', 'ip4:203.0.113.0/24', 'redirect=other.example']);
		expect(extractOtherMechanisms('v=spf1  ~all ')).toEqual([]);
	});

	it('builds a record from includes, other mechanisms and a qualifier', () => {
		expect(buildSpfRecord(['_spf.google.com'])).toBe('v=spf1 include:_spf.google.com ~all');
		expect(buildSpfRecord(['a.example', 'b.example'], '-all', ['mx', 'ip4:192.0.2.1'])).toBe('v=spf1 include:a.example include:b.example mx ip4:192.0.2.1 -all');
		expect(buildSpfRecord([], '~all', ['mx'])).toBe('v=spf1 mx ~all');
	});

	it('round-trips: re-building an existing record preserves what it said', () => {
		const rebuilt = buildSpfRecord(extractIncludes(record), existingQualifier(record), extractOtherMechanisms(record));
		expect(rebuilt).toBe('v=spf1 include:_spf.google.com include:custom.example.net mx ip4:203.0.113.0/24 redirect=other.example -all');
	});

	it('defaults to softfail unless the record already hardfails', () => {
		expect(existingQualifier(null)).toBe('~all');
		expect(existingQualifier('v=spf1 ~all')).toBe('~all');
		expect(existingQualifier('v=spf1 -all')).toBe('-all');
	});

	it('normalises custom includes and rejects junk', () => {
		expect(normalizeCustomInclude(' Include:Spf.Example.com ')).toBe('spf.example.com');
		expect(normalizeCustomInclude('_spf.example.com')).toBe('_spf.example.com');
		expect(normalizeCustomInclude('not a domain')).toBeNull();
		expect(normalizeCustomInclude('localhost')).toBeNull();
	});

	it('bands lookup counts around the limit of 10', () => {
		expect([0, 7, 8, 9, 10, 11].map(lookupLevel)).toEqual(['ok', 'ok', 'near', 'near', 'over', 'over']);
	});
});

describe('dmarc-record.ts', () => {
	it('creates a fresh record when there is none', () => {
		expect(buildRecommendedRecord(null, 'none', 'r@reports.example.com')).toBe('v=DMARC1; p=none; rua=mailto:r@reports.example.com');
	});

	it('changes p= and keeps every other tag', () => {
		const out = buildRecommendedRecord('v=DMARC1; p=none; rua=mailto:a@x.com; fo=1; pct=50', 'quarantine', 'r@reports.example.com');
		expect(out).toBe('v=DMARC1; p=quarantine; rua=mailto:a@x.com,mailto:r@reports.example.com; fo=1; pct=50');
	});

	it('does not add our rua twice', () => {
		const cur = 'v=DMARC1; p=none; rua=mailto:r@reports.example.com';
		expect(buildRecommendedRecord(cur, 'reject', 'r@reports.example.com')).toBe('v=DMARC1; p=reject; rua=mailto:r@reports.example.com');
	});

	it('appends p= when the record has none, and rua= when it has none', () => {
		expect(buildRecommendedRecord('v=DMARC1', 'none', 'r@x.com')).toBe('v=DMARC1; p=none; rua=mailto:r@x.com');
	});

	it('never mistakes sp= for p=', () => {
		const out = buildRecommendedRecord('v=DMARC1; sp=none; p=reject; rua=mailto:r@x.com', 'quarantine', 'r@x.com');
		expect(out).toBe('v=DMARC1; sp=none; p=quarantine; rua=mailto:r@x.com');
		expect(parseDmarcPolicy('v=DMARC1; sp=reject; p=none')).toBe('none');
		expect(parseDmarcPolicy('v=DMARC1; sp=reject')).toBeNull();
		expect(parseDmarcPolicy(null)).toBeNull();
	});
});

describe('email-service-providers.ts', () => {
	it('has the 16 SPF providers', () => {
		expect(SPF_PROVIDERS).toHaveLength(16);
	});

	it('matches selectors from FQDN, partial or bare names', () => {
		expect(matchDkimProvider('google._domainkey.example.com')?.name).toBe('Google Workspace');
		expect(matchDkimProvider('selector2._domainkey')?.name).toBe('Microsoft 365');
		expect(matchDkimProvider('fm1')?.name).toBe('Fastmail');
		expect(matchDkimProvider('weird._domainkey.example.com')).toBeNull();
	});

	it('detects providers by exact include, not by substring', () => {
		expect(detectProviders('v=spf1 include:_spf.google.com ~all').map((p) => p.name)).toEqual(['Google Workspace']);
		expect(detectProviders('v=spf1 include:zoho.com.evil.example ~all')).toEqual([]);
	});

	it('flags SPF providers without a detected DKIM selector; selector-less providers are always unsigned', () => {
		const spf = 'v=spf1 include:_spf.google.com include:amazonses.com ~all';
		expect(findUnsignedSpfProviders([], spf).map((p) => p.name)).toEqual(['Google Workspace', 'Amazon SES']);
		expect(findUnsignedSpfProviders([{ name: 'google._domainkey.example.com' }], spf).map((p) => p.name)).toEqual(['Amazon SES']);
		expect(findUnsignedSpfProviders([], null)).toEqual([]);
	});

	it('lists probe selectors without duplicates', () => {
		const all = getAllDkimSelectors();
		expect(new Set(all).size).toBe(all.length);
		expect(all).toEqual(expect.arrayContaining(['google', 'fm1', 'default']));
	});
});

describe('setup step logic', () => {
	const w = (over: Partial<typeof DEFAULT_WIZARD>) => ({ ...DEFAULT_WIZARD, domain: 'complete' as const, ...over });

	it('honours an explicit step from 2 to 5', () => {
		expect(resolveStep(3, w({}))).toBe(3);
		expect(resolveStep(5, w({ routing: 'complete' }))).toBe(5);
	});

	it('resumes at the first step still not started when there is no step, or step 1', () => {
		expect(resolveStep(null, w({}))).toBe(2);
		expect(resolveStep(1, w({ spf: 'complete' }))).toBe(3);
		expect(resolveStep(null, w({ spf: 'complete', dkim: 'skipped' }))).toBe(4);
	});

	it('falls back to SPF when every step is complete or skipped, and for out-of-range steps', () => {
		expect(resolveStep(null, w({ spf: 'complete', dkim: 'complete', dmarc: 'skipped', routing: 'complete' }))).toBe(2);
		expect(resolveStep(9, w({ spf: 'complete' }))).toBe(3);
		expect(resolveStep(0, w({}))).toBe(2);
	});

	it('assigns dns_errors to the check they belong to', () => {
		const status = { dns_errors: ['spf: timeout', 'dkim google: SERVFAIL', 'dkim s1: SERVFAIL', 'null-sender spf: x', 'auth record: y', 'mx: z'] };
		expect(dnsErrorsFor(status, 'spf')).toEqual(['spf: timeout']);
		expect(dnsErrorsFor(status, 'dkim')).toHaveLength(2);
		expect(dnsErrorsFor(status, 'nullSender')).toHaveLength(1);
		expect(dnsErrorsFor(status, 'authRecord')).toHaveLength(1);
		expect(dnsErrorsFor(status, 'mx')).toHaveLength(1);
		expect(dnsErrorsFor(status, 'dmarc')).toEqual([]);
		expect(dnsErrorsFor({}, 'spf')).toEqual([]);
	});

	it('reports a failed lookup as unknown, never as missing', () => {
		expect(spfSeverity({ record: null, lookup_count: null, flattening_active: false }, true)).toBe('unknown');
		expect(spfSeverity({ record: null, lookup_count: null, flattening_active: false })).toBe('warning');
		expect(dkimSeverity({ selectors: [], source: 'doh' }, null, 0, true)).toBe('unknown');
		expect(dkimSeverity({ selectors: [], source: 'doh' }, 'reject', 0)).toBe('warning');
		const r = { mx_found: false, destination_verified: false, reports_domain: 'reports.x.com', admin_email: null };
		expect(routingSeverity(r, true)).toBe('unknown');
		expect(routingSeverity(r)).toBe('error');
	});

	it('grades SPF lookup counts', () => {
		const s = (n: number) => spfSeverity({ record: 'v=spf1 ~all', lookup_count: n, flattening_active: false });
		expect([s(3), s(8), s(10)]).toEqual(['good', 'warning', 'error']);
	});
});
