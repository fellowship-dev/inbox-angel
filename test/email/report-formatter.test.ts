import { describe, it, expect } from 'vitest';
import { buildSummary, formatCheckReport, OverallStatus } from '../../src/email/report-formatter';
import type { AuthResultsHeader } from '../../src/email/parse-headers';
import type { DnsCheckResult } from '../../src/email/dns-check';

// ── Fixtures ─────────────────────────────────────────────────

function makeAuth(overrides: Partial<{
  spfResult: string;
  dkimResult: string;
  dkimSelector: string;
  dmarcResult: string;
  dmarcPolicy: string;
  dmarcDisposition: string;
}>= {}): AuthResultsHeader {
  return {
    spf: { result: (overrides.spfResult ?? 'pass') as any, domain: 'example.com' },
    dkim: {
      result: (overrides.dkimResult ?? 'pass') as any,
      domain: 'example.com',
      selector: overrides.dkimSelector ?? 'sel1',
    },
    dmarc: {
      result: (overrides.dmarcResult ?? 'pass') as any,
      domain: 'example.com',
      policy: overrides.dmarcPolicy ?? 'reject',
      disposition: overrides.dmarcDisposition ?? 'none',
    },
    raw: '',
  };
}

function makeDns(overrides: Partial<{
  spfVerdict: string;
  dkimPresent: boolean;
  dmarcPolicy: string;
}>= {}): DnsCheckResult {
  return {
    domain: 'example.com',
    spf: {
      raw: 'v=spf1 -all',
      mechanisms: ['-all'],
      verdict: (overrides.spfVerdict ?? 'strict') as any,
    },
    dkim: overrides.dkimPresent === false ? null : {
      raw: 'v=DKIM1; k=rsa; p=ABC',
      version: 'DKIM1',
      keyType: 'rsa',
      present: true,
    },
    dmarc: {
      raw: `v=DMARC1; p=${overrides.dmarcPolicy ?? 'reject'}`,
      policy: (overrides.dmarcPolicy ?? 'reject') as any,
      subdomainPolicy: (overrides.dmarcPolicy ?? 'reject') as any,
      pct: 100,
      rua: ['mailto:dmarc@example.com'],
      ruf: [],
    },
  };
}

// ── buildSummary ──────────────────────────────────────────────

describe('buildSummary', () => {
  it('returns protected when DMARC passes and at least one of SPF/DKIM passes', () => {
    const s = buildSummary('example.com', makeAuth(), makeDns());
    expect(s.status).toBe<OverallStatus>('protected');
    expect(s.spfPass).toBe(true);
    expect(s.dkimPass).toBe(true);
    expect(s.dmarcPass).toBe(true);
  });

  it('returns protected when DMARC passes and only DKIM passes (SPF failed)', () => {
    const s = buildSummary('example.com', makeAuth({ spfResult: 'fail' }), makeDns());
    expect(s.status).toBe<OverallStatus>('protected');
  });

  it('returns protected when DMARC passes and only SPF passes (DKIM failed)', () => {
    const s = buildSummary('example.com', makeAuth({ dkimResult: 'fail' }), makeDns());
    expect(s.status).toBe<OverallStatus>('protected');
  });

  it('returns exposed when no DMARC policy exists', () => {
    const auth = makeAuth({ dmarcResult: 'fail', dmarcPolicy: 'none' });
    const dns = makeDns({ dmarcPolicy: 'none' });
    const s = buildSummary('example.com', auth, dns);
    expect(s.status).toBe<OverallStatus>('exposed');
  });

  it('returns exposed when auth and dns both have no DMARC', () => {
    const auth: AuthResultsHeader = {
      spf: { result: 'fail', domain: null },
      dkim: null,
      dmarc: null,
      raw: '',
    };
    const dns: DnsCheckResult = {
      domain: 'example.com',
      spf: null,
      dkim: null,
      dmarc: null,
    };
    const s = buildSummary('example.com', auth, dns);
    expect(s.status).toBe<OverallStatus>('exposed');
  });

  it('returns at_risk when DMARC policy exists but check failed', () => {
    const s = buildSummary(
      'example.com',
      makeAuth({ dmarcResult: 'fail', spfResult: 'fail', dkimResult: 'fail' }),
      makeDns({ dmarcPolicy: 'quarantine' }),
    );
    expect(s.status).toBe<OverallStatus>('at_risk');
  });

  it('prefers dns.dmarc.policy over auth.dmarc.policy', () => {
    const auth = makeAuth({ dmarcPolicy: 'none' });
    const dns = makeDns({ dmarcPolicy: 'reject' });
    const s = buildSummary('example.com', auth, dns);
    expect(s.dmarcPolicy).toBe('reject');
  });

  it('works with null auth results (no Authentication-Results header)', () => {
    const s = buildSummary('example.com', null, makeDns({ dmarcPolicy: 'none' }));
    expect(s.spfPass).toBe(false);
    expect(s.dkimPass).toBe(false);
    expect(s.dmarcPass).toBe(false);
    expect(s.status).toBe<OverallStatus>('exposed');
  });

  it('reports dkimPresent from dns.dkim, not from auth', () => {
    const auth = makeAuth({ dkimResult: 'fail' }); // DKIM failed but key exists in DNS
    const dns = makeDns(); // dkim record present
    const s = buildSummary('example.com', auth, dns);
    expect(s.dkimPresent).toBe(true);
  });
});

// ── formatCheckReport ─────────────────────────────────────────

describe('formatCheckReport', () => {
  it('includes domain name in the header line', () => {
    const auth = makeAuth();
    const dns = makeDns();
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('example.com');
  });

  it('shows ✅ for all three when fully protected', () => {
    const auth = makeAuth();
    const dns = makeDns();
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    const checks = report.match(/✅/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3); // SPF, DKIM, DMARC
  });

  it('shows 🚨 status line when exposed', () => {
    const auth: AuthResultsHeader = {
      spf: { result: 'fail', domain: null },
      dkim: null,
      dmarc: null,
      raw: '',
    };
    const dns: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
    const summary = buildSummary('example.com', null, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('🚨');
  });

  it('shows ⚠️ status line when at_risk', () => {
    const auth = makeAuth({ dmarcResult: 'fail', spfResult: 'fail', dkimResult: 'fail' });
    const dns = makeDns({ dmarcPolicy: 'quarantine' });
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('⚠️');
  });

  it('includes raw SPF record in DNS section', () => {
    const auth = makeAuth();
    const dns = makeDns();
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('v=spf1 -all');
  });

  it('shows (none found) when DNS records are missing', () => {
    const dns: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
    const summary = buildSummary('example.com', null, dns);
    const report = formatCheckReport('user@example.com', summary, null, dns);
    expect(report).toContain('(none found)');
  });

  it('shows DKIM selector when available', () => {
    const auth = makeAuth({ dkimSelector: 'google' });
    const dns = makeDns();
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('google');
  });

  it('includes "what to do next" section for at_risk', () => {
    const auth = makeAuth({ dmarcResult: 'fail', dkimResult: 'fail', spfResult: 'fail' });
    const dns = makeDns({ dmarcPolicy: 'none' });
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report.toLowerCase()).toContain('what to do next');
  });

  it('mentions inboxangel.com in the footer', () => {
    const auth = makeAuth();
    const dns = makeDns();
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('inboxangel.com');
  });

  it('DKIM line mentions "no signing key" when dkim DNS record is missing and no selector', () => {
    const auth: AuthResultsHeader = { spf: null, dkim: null, dmarc: null, raw: '' };
    const dns: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('no selector');
  });

  it('DKIM line distinguishes "key exists but not signed" from "no key at all"', () => {
    // Key present in DNS, but this email had no DKIM signature
    const auth = makeAuth({ dkimResult: 'fail' });
    const dns = makeDns(); // DKIM record present
    const summary = buildSummary('example.com', auth, dns);
    const report = formatCheckReport('user@example.com', summary, auth, dns);
    expect(report).toContain('exists but this email was not signed');
  });
});

describe('DNS lookup failures are not reported as missing records', () => {
  const failed = (errors: NonNullable<DnsCheckResult['errors']>): DnsCheckResult => ({
    domain: 'example.com', spf: null, dkim: null, dmarc: null, errors,
  });

  it('DMARC lookup failure says "could not look up", not "No policy set"', () => {
    const dns = failed({ dmarc: 'DNS SERVFAIL' });
    const summary = buildSummary('example.com', null, dns);
    const text = formatCheckReport('a@example.com', summary, null, dns);
    expect(summary.dmarcLookupFailed).toBe(true);
    expect(text).toContain('could not look up your DMARC record');
    expect(text).toContain('DMARC record: (could not be checked');
    expect(text).not.toContain('No policy set');
    expect(text).not.toContain('Add a DMARC record');
  });

  it('SPF lookup failure is distinguished from "(none found)"', () => {
    const dns = failed({ spf: 'timeout' });
    const text = formatCheckReport('a@example.com', buildSummary('example.com', null, dns), null, dns);
    expect(text).toContain('SPF record:   (could not be checked');
    expect(text).not.toContain('SPF record:   (none found)');
    expect(text).not.toContain('Add an SPF record');
  });

  it('a genuinely missing record is still reported as missing', () => {
    const dns: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
    const text = formatCheckReport('a@example.com', buildSummary('example.com', null, dns), null, dns);
    expect(text).toContain('SPF record:   (none found)');
    expect(text).toContain('DMARC record: (none found)');
    expect(text).toContain('No policy set');
  });
});

describe('broken (permerror) records are not described as lookup failures', () => {
  it('multiple SPF records → "broken", not "could not look up"', () => {
    const dns: DnsCheckResult = { domain: 'example.com', spf: { raw: 'v=spf1 -all  |  v=spf1 +all', mechanisms: [], terms: [], verdict: 'missing', permerror: 'x publishes 2 SPF records' } as any, dkim: null, dmarc: null, problems: { spf: 'x publishes 2 SPF records' } };
    const text = formatCheckReport('a@example.com', buildSummary('example.com', null, dns), null, dns);
    expect(text).toContain('Your SPF record is broken: x publishes 2 SPF records');
    expect(text).toContain('Fix your SPF record: publish exactly one');
    expect(text).not.toContain('could not look up your SPF');
  });
});
