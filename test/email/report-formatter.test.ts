import { describe, it, expect } from 'vitest';
import { CATALOG } from '@inbox-angel/report';
import { buildSummary, fixSteps, formatCheckReport, OverallStatus } from '../../src/email/report-formatter';
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
    expect(text).not.toContain('Publish a DMARC record');
  });

  it('SPF lookup failure is distinguished from "(none found)"', () => {
    const dns = failed({ spf: 'timeout' });
    const text = formatCheckReport('a@example.com', buildSummary('example.com', null, dns), null, dns);
    expect(text).toContain('SPF record:   (could not be checked');
    expect(text).not.toContain('SPF record:   (none found)');
    expect(text).not.toContain('Publish an SPF record');
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
    expect(text).toContain('Merge your SPF records into one');
    expect(text).not.toContain('could not look up your SPF');
  });
});

describe('closing: help line, truthful retention, configured site link', () => {
  const HELP = 'Need help? Any doubts? Reply.';
  const exposedDns: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
  const cases = () => [
    { auth: makeAuth(), dns: makeDns() },
    { auth: null, dns: exposedDns },
    { auth: makeAuth({ dmarcResult: 'fail' }), dns: makeDns({ dmarcPolicy: 'quarantine' }) },
  ];

  it('ends with the help line, enrolled or not, in every status', () => {
    for (const { auth, dns } of cases()) {
      const summary = buildSummary('example.com', auth, dns);
      expect(formatCheckReport('a@example.com', summary, auth, dns).trimEnd().endsWith(HELP)).toBe(true);
      const enrolled = formatCheckReport('a@example.com', summary, auth, dns, { enrolled: { text: 'We will send you 5 short emails.', unsubscribeUrl: 'https://w.example/u?t=1' } });
      expect(enrolled.trimEnd().endsWith(HELP)).toBe(true);
      expect(enrolled).toContain('Unsubscribe: https://w.example/u?t=1');
    }
  });

  it('never claims nothing is stored and never links inboxangel.com', () => {
    for (const { auth, dns } of cases()) {
      const text = formatCheckReport('a@example.com', buildSummary('example.com', auth, dns), auth, dns);
      expect(text).not.toContain('No data about your domain is stored');
      expect(text).not.toContain('inboxangel.com');
    }
  });

  it('not enrolled: states the configured check-result retention (default 30 days)', () => {
    const summary = buildSummary('example.com', null, exposedDns);
    expect(formatCheckReport('a@example.com', summary, null, exposedDns)).toContain('We keep your address and this result for 30 days, then delete them.');
    expect(formatCheckReport('a@example.com', summary, null, exposedDns, { retentionDays: 7 })).toContain('for 7 days, then delete them.');
  });

  it('enrolled: result deleted after N days; address used until unsubscribe, then kept only on a do-not-contact list', () => {
    const summary = buildSummary('example.com', null, exposedDns);
    const text = formatCheckReport('a@example.com', summary, null, exposedDns, { enrolled: { text: 'x', unsubscribeUrl: 'https://w.example/u' }, retentionDays: 14 });
    expect(text).toContain('We keep your address and a summary of this result for our follow-up emails until you unsubscribe (or 12 months after your last check); after you unsubscribe we keep only your address, on a do-not-contact list. The full result is deleted after 14 days.');
    expect(text).not.toContain('delete them when you unsubscribe');
  });

  it('already known but no longer receiving follow-ups: kept up to 12 months after the last check', () => {
    const summary = buildSummary('example.com', null, exposedDns);
    const text = formatCheckReport('a@example.com', summary, null, exposedDns, { lead: 'inactive' });
    expect(text).toContain('We keep your address and a summary of this result for up to 12 months after your last check, then delete them.');
    expect(text).not.toContain('for 30 days');
  });

  it('on the do-not-contact list: says it stays there, and when the result goes', () => {
    const summary = buildSummary('example.com', null, exposedDns);
    const text = formatCheckReport('a@example.com', summary, null, exposedDns, { lead: 'suppressed', retentionDays: 30 });
    expect(text).toContain('Your address is on our do-not-contact list and stays there, so you get no follow-up emails. We delete this result after 30 days.');
    expect(text).not.toContain('then delete them');
  });

  it('links the configured site URL, and no site at all when it is unset', () => {
    const summary = buildSummary('example.com', null, exposedDns);
    expect(formatCheckReport('a@example.com', summary, null, exposedDns, { siteUrl: 'https://inboxangel.io' })).toContain('https://inboxangel.io');
    expect(formatCheckReport('a@example.com', summary, null, exposedDns)).not.toMatch(/https?:\/\//);
  });
});

describe('actionable findings: the exact record or setting to change, then "or we do it for you"', () => {
  const NO_RECORDS: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
  const report = (auth: AuthResultsHeader | null, dns: DnsCheckResult, opts = {}) =>
    formatCheckReport('a@example.com', buildSummary('example.com', auth, dns), auth, dns, opts);

  it('no DMARC record: the exact _dmarc TXT record and the "mailbox you read" note', () => {
    const text = report(null, NO_RECORDS);
    expect(text).toContain('_dmarc.example.com');
    expect(text).toContain('v=DMARC1; p=none; rua=mailto:dmarc@example.com');
    expect(text).toMatch(/change the address to one you read/);
  });

  it('DMARC p=none and this email failed DMARC: names p=quarantine as the next step', () => {
    const text = report(makeAuth({ dmarcPolicy: 'none', dmarcResult: 'fail' }), makeDns({ dmarcPolicy: 'none' }));
    expect(text).toMatch(/_dmarc\.example\.com from p=none to p=quarantine/);
  });

  it('DMARC p=reject and everything passing: no fix block, only the help line', () => {
    const text = report(makeAuth(), makeDns());
    expect(text).not.toContain('What to do next');
    expect(text).not.toMatch(/or we do it/i);
    expect(text.trimEnd().endsWith('Need help? Any doubts? Reply.')).toBe(true);
  });

  it('DKIM fail: names the signing domain and selector seen, and the record to check', () => {
    const auth: AuthResultsHeader = { ...makeAuth({ dkimResult: 'fail', dmarcResult: 'fail' }), dkim: { result: 'fail', domain: 'mailer.example.net', selector: 's2024' } };
    const text = report(auth, makeDns({ dmarcPolicy: 'quarantine' }));
    expect(text).toContain('d=mailer.example.net');
    expect(text).toContain('s=s2024');
    expect(text).toContain('s2024._domainkey.mailer.example.net');
  });

  it('SPF fail: names the envelope domain and says to add the sender at the provider, without inventing an include', () => {
    const auth: AuthResultsHeader = { ...makeAuth({ spfResult: 'fail', dmarcResult: 'fail', dkimResult: 'fail' }), spf: { result: 'fail', domain: 'bounce.example.com' } };
    const text = report(auth, makeDns({ dmarcPolicy: 'quarantine' }));
    const step = text.split('\n').find(l => l.includes('SPF failed'))!;
    expect(step).toContain('bounce.example.com');
    expect(step).toMatch(/provider/);
    expect(text).not.toMatch(/include:/);
  });

  it('"or we do it for you": BOOKING_URL, else SITE_URL/pricing, else plain text', () => {
    expect(report(null, NO_RECORDS, { bookingUrl: 'https://cal.example/max', siteUrl: 'https://inboxangel.io' })).toContain('Or we do it for you: https://cal.example/max');
    expect(report(null, NO_RECORDS, { siteUrl: 'https://inboxangel.io' })).toContain('Or we do it for you: https://inboxangel.io/pricing');
    const plain = report(null, NO_RECORDS);
    const line = plain.split('\n').find(l => l.startsWith('Or we do it for you'))!;
    expect(line).toBeDefined();
    expect(line).not.toMatch(/https?:/);
  });
});

// ── U5: record fixes come from the @inbox-angel/report catalog ──

describe('record fixes come from the catalog; message-derived steps stay', () => {
  const NO_RECORDS: DnsCheckResult = { domain: 'example.com', spf: null, dkim: null, dmarc: null };
  const GOOGLE_MX = { status: 'found' as const, hosts: [{ priority: 1, host: 'aspmx.l.google.com' }] };
  const catalogValue = (finding: string, provider = '*') =>
    CATALOG[finding].entries.find(e => e.provider === provider)!.records[0].value.replace(/\{domain\}/g, 'example.com');
  const steps = (auth: AuthResultsHeader | null, dns: DnsCheckResult) => fixSteps(buildSummary('example.com', auth, dns), auth, dns);

  it('no DMARC: the step\'s record is the catalog\'s dmarc-missing record', () => {
    const dmarc = steps(null, NO_RECORDS).find(st => st.record?.name === '_dmarc.example.com')!;
    expect(dmarc.record!.value).toBe(catalogValue('dmarc-missing'));
    expect(dmarc.record!.type).toBe('TXT');
  });

  it('Google Workspace mailbox (MX) with no SPF: the SPF step names the Google include', () => {
    const spf = steps(null, { ...NO_RECORDS, mx: GOOGLE_MX }).find(st => st.record?.name === 'example.com')!;
    expect(spf.record!.value).toBe('v=spf1 include:_spf.google.com ~all');
    expect(spf.record!.value).toBe(catalogValue('spf-missing', 'google-workspace'));
  });

  it('no MX answer: the SPF step is the generic catalog record, with the include left for the provider', () => {
    const spf = steps(null, NO_RECORDS).find(st => st.record?.name === 'example.com')!;
    expect(spf.record!.value).toBe(catalogValue('spf-missing'));
  });

  it('a DKIM failure from the received mail keeps the selector-specific step alongside the catalog fixes', () => {
    const auth: AuthResultsHeader = { ...makeAuth({ spfResult: 'fail', dkimResult: 'fail', dmarcResult: 'fail' }), dkim: { result: 'fail', domain: 'example.com', selector: 's2024' } };
    const all = steps(auth, { ...NO_RECORDS, mx: GOOGLE_MX });
    expect(all.some(st => st.text.includes('s2024._domainkey.example.com'))).toBe(true);
    expect(all.some(st => st.record?.value === catalogValue('dmarc-missing'))).toBe(true);
    expect(all.some(st => st.record?.value === 'v=spf1 include:_spf.google.com ~all')).toBe(true);
  });

  it('a lookup failure still yields the retry step and no record fix for the unchecked record', () => {
    const dns: DnsCheckResult = { ...NO_RECORDS, errors: { dmarc: 'SERVFAIL' } };
    const all = steps(null, dns);
    expect(all[0].text).toMatch(/Send another email/);
    expect(all.some(st => st.record?.name === '_dmarc.example.com')).toBe(false);
  });

  it('the email makes no cross-check or multi-resolver claim', () => {
    for (const [auth, dns] of [[null, NO_RECORDS], [makeAuth(), makeDns()], [makeAuth({ dmarcResult: 'fail' }), makeDns({ dmarcPolicy: 'quarantine' })]] as const) {
      const text = formatCheckReport('a@example.com', buildSummary('example.com', auth, dns), auth, dns);
      expect(text).not.toMatch(/resolver|cross-check|consensus|confirmed|three/i);
    }
  });
});

describe('share links when fully protected', () => {
  const urls = (text: string) => text.match(/https:\/\/[^\s"<]+/g) ?? [];
  const sharedText = (u: string) => new URL(u.replace(/&amp;/g, '&')).searchParams.get('text')!;

  it('protected: X and LinkedIn intent links with URL-encoded prefilled text naming the domain and the passing checks', () => {
    const text = formatCheckReport('a@example.com', buildSummary('example.com', makeAuth(), makeDns()), makeAuth(), makeDns());
    const x = urls(text).find(u => u.startsWith('https://x.com/intent/tweet?text='))!;
    const li = urls(text).find(u => u.startsWith('https://www.linkedin.com/feed/?shareActive=true&text='))!;
    for (const u of [x, li]) {
      expect(u).toBeDefined();
      expect(u).not.toMatch(/ /);
      expect(sharedText(u)).toContain('example.com');
      expect(sharedText(u)).toMatch(/SPF.*DKIM.*DMARC/);
    }
  });

  it('protected with only DKIM passing: the shared text does not claim SPF', () => {
    const auth = makeAuth({ spfResult: 'fail' });
    const text = formatCheckReport('a@example.com', buildSummary('example.com', auth, makeDns()), auth, makeDns());
    const x = urls(text).find(u => u.startsWith('https://x.com/intent/tweet'))!;
    expect(sharedText(x)).not.toContain('SPF');
  });

  it('at risk and exposed: no share links', () => {
    for (const [auth, dns] of [[makeAuth({ dmarcResult: 'fail' }), makeDns({ dmarcPolicy: 'quarantine' })], [null, { domain: 'example.com', spf: null, dkim: null, dmarc: null }]] as const) {
      const text = formatCheckReport('a@example.com', buildSummary('example.com', auth, dns), auth, dns);
      expect(text).not.toContain('x.com/intent');
      expect(text).not.toContain('linkedin.com');
    }
  });
});

// ── Review fixes: catalog record fixes follow what the received message failed ──

describe('catalog record fixes only for the protocol the received message failed', () => {
  const report = (auth: AuthResultsHeader | null, dns: DnsCheckResult) =>
    formatCheckReport('a@example.com', buildSummary('example.com', auth, dns), auth, dns, { siteUrl: 'https://inboxangel.io' });
  const steps = (auth: AuthResultsHeader | null, dns: DnsCheckResult) => fixSteps(buildSummary('example.com', auth, dns), auth, dns);

  it('protected with no SPF record: no fix steps and no "do it for you", share links stay', () => {
    const auth = makeAuth({ spfResult: 'fail' });
    const dns: DnsCheckResult = { ...makeDns(), spf: null };
    expect(buildSummary('example.com', auth, dns).status).toBe<OverallStatus>('protected');
    expect(steps(auth, dns)).toEqual([]);
    const text = report(auth, dns);
    expect(text).not.toContain('What to do next');
    expect(text).not.toMatch(/Publish an SPF record|or we do it for you/i);
    expect(text).toContain('x.com/intent/tweet');
  });

  it('at risk with SPF passing on the message: no catalog SPF fix, the DMARC failure still gets its steps', () => {
    const auth = makeAuth({ dkimResult: 'fail', dmarcResult: 'fail', dmarcPolicy: 'quarantine' });
    const dns: DnsCheckResult = { ...makeDns({ dmarcPolicy: 'quarantine' }), spf: null }; // SPF passed for another envelope domain
    const s = buildSummary('example.com', auth, dns);
    expect(s.status).toBe<OverallStatus>('at_risk');
    const all = steps(auth, dns);
    expect(all.some(st => st.record?.name === 'example.com')).toBe(false);
    expect(all.length).toBeGreaterThan(0);
  });

  it('exposed with SPF failing: the catalog SPF fix is kept', () => {
    const auth = makeAuth({ spfResult: 'fail', dkimResult: 'fail', dmarcResult: 'fail', dmarcPolicy: 'none' });
    const dns: DnsCheckResult = { ...makeDns({ dmarcPolicy: 'none' }), spf: null };
    expect(steps(auth, dns).some(st => st.record?.name === 'example.com')).toBe(true);
  });

  it('dmarc-p-none-no-rua: one DMARC step (the catalog record), not also the p=none to p=quarantine edit', () => {
    const auth = makeAuth({ dmarcResult: 'fail', dmarcPolicy: 'none', dkimResult: 'fail' });
    const dns = makeDns({ dmarcPolicy: 'none' });
    dns.dmarc = { ...dns.dmarc!, raw: 'v=DMARC1; p=none', rua: [] };
    const dmarcSteps = steps(auth, dns).filter(st => st.record?.name === '_dmarc.example.com' || st.text.includes('_dmarc.example.com'));
    expect(dmarcSteps).toHaveLength(1);
    expect(dmarcSteps[0].record?.value).toContain('rua=mailto:dmarc@example.com');
  });
});

describe('an inherited DMARC record gets no record fix at _dmarc.<subdomain>', () => {
  it('p=none with no rua inherited from the organizational domain: no catalog DMARC fix', () => {
    const dns: DnsCheckResult = {
      domain: 'mail.example.com', spf: null, dkim: null,
      dmarc: { raw: 'v=DMARC1; p=none', policy: 'none', subdomainPolicy: 'none', pct: 100, rua: [], ruf: [], inheritedFrom: '_dmarc.example.com' } as any,
    };
    const auth: AuthResultsHeader = { ...makeAuth({ dmarcResult: 'fail', dmarcPolicy: 'none', dkimResult: 'fail', spfResult: 'fail' }) };
    const all = fixSteps(buildSummary('mail.example.com', auth, dns), auth, dns);
    expect(all.some(st => st.record?.name?.startsWith('_dmarc.'))).toBe(false);
    expect(all.some(st => st.text.includes('_dmarc.mail.example.com'))).toBe(false);
  });
});
