// Port of unzip-inboxangel outreach-tools/tests/test_fixes.py and the catalog/fix half of test_bimi.py.
import { describe, expect, it } from 'vitest';
import { DNS_HOSTS, PROVIDERS, type DomainReport } from '@inbox-angel/dns-checks';
import { CATALOG, DNS_HOST_STEPS, build, enforcedDmarc, fill, type Fix } from '../src/index';
import { CHECKED, GOOGLE, M365, RESEND, SENDGRID, SES, bimiRec, makeRec, type RecOptions } from './helpers';

function fx(rec: DomainReport, fid: string): Fix {
  const out = build(rec, CHECKED);
  const f = out.findings.find(x => x.id === fid);
  if (!f) throw new Error(`no ${fid} finding; got ${out.findings.map(x => x.id).join(', ')}`);
  return fill(f, out.facts);
}
const steps = (f: Fix) => f.steps.join(' ');

describe('fixes (test_fixes.py)', () => {
  it('no _dmarc record yields dmarc-missing with an exact fix rua=mailto:dmarc@<domain>, Cloudflare steps', () => {
    const f = fx(makeRec('acme.dev', { providers: [GOOGLE], dnsHost: 'cloudflare' }), 'dmarc-missing');
    expect(f.exact).toBe(true);
    expect(f.records).toEqual([{ name: '_dmarc.acme.dev', host: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:dmarc@acme.dev', note: f.records[0].note }]);
    expect(steps(f)).toContain('DNS > Records > Add record');
    expect(steps(f)).toContain('`_dmarc`');
    expect(steps(f)).toContain('without surrounding quotes');
    expect(f.dnsHostLabel).toBe('Cloudflare');
  });

  it('@dns_host expands to generic steps (full name, no Cloudflare words) on any other host', () => {
    const f = fx(makeRec('acme.dev', { providers: [GOOGLE], dnsHost: 'godaddy' }), 'dmarc-missing');
    expect(steps(f)).toContain('`_dmarc.acme.dev`');
    expect(steps(f)).not.toContain('Cloudflare');
    expect(f.dnsHostLabel).toBe('your DNS host');
  });

  it('Google Workspace MX with no SPF yields the Google entry; an unknown provider the generic entry, not exact', () => {
    const g = fx(makeRec('acme.dev', { providers: [GOOGLE] }), 'spf-missing');
    expect(g.records[0].value).toBe('v=spf1 include:_spf.google.com ~all');
    expect(g.exact).toBe(true);
    expect(g.title).toContain('Google Workspace');
    const m = fx(makeRec('acme.dev', { providers: [M365], mx: ['found', ['x.mail.protection.outlook.com']] }), 'spf-missing');
    expect(m.records[0].value).toBe('v=spf1 include:spf.protection.outlook.com ~all');
    expect(m.exact).toBe(true);
    const unknown = fx(makeRec('acme.dev'), 'spf-missing');
    expect(unknown.exact).toBe(false);
    expect(unknown.records[0].value).toContain('<your mail provider');
    expect(steps(unknown)).toContain("provider's DNS settings page");
  });

  it('two v=spf1 records merge into one keeping every include and a single all term', () => {
    const issue = [{ code: 'multiple-records' as const, domain: 'acme.dev', message: '2' }];
    const f = fx(makeRec('acme.dev', { spf: 'permerror', spfRaws: ['v=spf1 include:_spf.google.com ~all', 'v=spf1 include:amazonses.com include:_spf.google.com -all'], spfIssues: issue }), 'multiple-spf');
    expect(f.records[0].value).toBe('v=spf1 include:_spf.google.com include:amazonses.com ~all');
    expect(f.records[0].value.match(/all/g)).toHaveLength(1);
    expect(f.exact).toBe(true);
    const strict = fx(makeRec('acme.dev', { spf: 'permerror', spfRaws: ['v=spf1 include:a.com -all', 'v=spf1 include:b.com -all'], spfIssues: issue }), 'multiple-spf');
    expect(strict.records[0].value).toBe('v=spf1 include:a.com include:b.com -all');
    const redirect = fx(makeRec('acme.dev', { spf: 'permerror', spfRaws: ['v=spf1 redirect=a.com', 'v=spf1 -all'], spfIssues: issue }), 'multiple-spf');
    expect(redirect.exact).toBe(false); // redirect= cannot be merged safely
  });

  it('spf-open rewrites only the ending and never keeps +all', () => {
    const f = fx(makeRec('acme.dev', { spf: 'ok', spfRaw: 'v=spf1 include:_spf.google.com +all', verdict: 'open' }), 'spf-open');
    expect(f.records[0].value).toBe('v=spf1 include:_spf.google.com ~all');
    expect(JSON.stringify(f.records)).not.toContain('+all');
  });

  it('spf-open wording per qualifier', () => {
    const neutral = fx(makeRec('a.dev', { spf: 'ok', spfRaw: 'v=spf1 include:x.com ?all', verdict: 'open' }), 'spf-open');
    expect(neutral.why).toContain('?all');
    expect(neutral.why).toContain('neutral');
    expect(neutral.why).not.toContain('any server');
    const plus = fx(makeRec('a.dev', { spf: 'ok', spfRaw: 'v=spf1 include:x.com +all', verdict: 'open' }), 'spf-open');
    expect(plus.why).toContain('+all');
    expect(plus.why).toContain('allows any server');
    expect(plus.records[0].value).toBe('v=spf1 include:x.com ~all');
  });

  it('a bare all is not rewritten to authorise nobody', () => {
    for (const raw of ['v=spf1 +all', 'v=spf1 ?all', 'v=spf1 all']) {
      const f = fx(makeRec('a.dev', { spf: 'ok', spfRaw: raw, verdict: 'open' }), 'spf-open');
      expect(f.exact).toBe(false);
      expect(f.records).toEqual([]);
      expect(steps(f)).toContain('List your sending services first');
    }
  });

  it('DKIM is never exact and names where to find the record', () => {
    const f = fx(makeRec('acme.dev', { spf: 'ok', spfRaw: 'v=spf1 include:resend.com ~all', providers: [RESEND], mx: ['none', []] }), 'dkim-not-found-for-sender');
    expect(f.exact).toBe(false);
    expect(f.provider?.id).toBe('resend');
    expect(steps(f)).toContain('Records tab');
    expect(f.needsFromProvider.length).toBeGreaterThan(0);
  });

  it('over 10 lookups shows provider hints for detected senders', () => {
    const f = fx(makeRec('acme.dev', {
      spf: 'permerror', spfRaw: 'v=spf1 include:amazonses.com ~all', lookups: 12, providers: [SES], spfIncludes: ['amazonses.com'],
      spfIssues: [{ code: 'lookup-limit', domain: 'acme.dev', message: '12' }],
    }), 'spf-over-10-lookups');
    expect(f.hints.some(h => h.includes('Amazon SES'))).toBe(true);
    expect(f.exact).toBe(false);
    expect(f.why).toContain('12');
  });

  it('dmarc-missing does not promise reports in why, offers another mailbox as a next step', () => {
    const f = fx(makeRec('acme.dev', { providers: [GOOGLE] }), 'dmarc-missing');
    expect(f.why.toLowerCase()).not.toContain('report');
    expect(f.optionalNext).toContain('rua=mailto:<a mailbox you read>');
    expect(f.optionalNext).toContain('Inbox Angel receive and read them');
  });

  it('dmarc-p-none-no-rua wording', () => {
    const f = fx(makeRec('acme.dev', { dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none', spf: 'ok', spfRaw: 'v=spf1 ~all' }), 'dmarc-p-none-no-rua');
    expect(f.why).toContain('nowhere to send reports');
    expect(f.why).not.toContain('must not');
  });

  it('the CNAME proxy step appears only for CNAME records', () => {
    const txt = steps(fx(makeRec('a.dev', { providers: [GOOGLE], dnsHost: 'cloudflare' }), 'dmarc-missing'));
    expect(txt).not.toContain('grey cloud');
    expect(txt).not.toContain('Proxy');
    expect(steps(fx(makeRec('a.dev', { providers: [GOOGLE], dnsHost: 'godaddy' }), 'dmarc-missing')).toLowerCase()).not.toContain('proxy');
    const sg = fx(makeRec('a.dev', { spf: 'ok', spfRaw: 'v=spf1 include:sendgrid.net ~all', providers: [SENDGRID], mx: ['none', []] }), 'dkim-not-found-for-sender');
    expect(steps(sg)).toContain('grey cloud'); // SendGrid's DKIM records are CNAMEs; Cloudflare asks for DNS only
  });

  it('the Resend note is about the DKIM TXT key, the CNAME mention is for SPF', () => {
    const f = fx(makeRec('a.dev', { spf: 'ok', spfRaw: 'v=spf1 include:resend.com ~all', providers: [RESEND], mx: ['none', []] }), 'dkim-not-found-for-sender');
    expect(f.records[0].note).toContain('TXT record with a public key');
    expect(f.records[0].note).not.toContain('CNAME');
    expect(steps(f)).toContain('for SPF');
    expect(f.sources.some(s => s.includes('manage-domains'))).toBe(true);
  });
});

describe('catalog', () => {
  it('every entry has sources or says check the provider', () => {
    expect(DNS_HOST_STEPS.hosts.cloudflare.sources.length).toBeGreaterThan(0);
    for (const [name, data] of Object.entries(CATALOG)) {
      expect(data.finding).toBe(name);
      for (const e of data.entries) {
        expect(e.sources.length > 0 || JSON.stringify(e).includes("provider's DNS settings page"), `${name} ${e.provider}`).toBe(true);
        expect(e.title && e.why && e.steps.length).toBeTruthy();
      }
    }
  });

  it('covers the required stack', () => {
    const dkim = new Set(CATALOG['dkim-not-found-for-sender'].entries.map(e => e.provider));
    for (const p of ['resend', 'google-workspace', 'amazon-ses', 'postmark', 'sendgrid', 'microsoft-365', '*']) expect(dkim.has(p)).toBe(true);
    expect(Object.keys(DNS_HOST_STEPS.hosts).sort()).toEqual(['cloudflare', 'generic']);
    const spf = new Set(CATALOG['spf-missing'].entries.map(e => e.provider));
    expect(spf.has('google-workspace') && spf.has('microsoft-365')).toBe(true);
  });

  it('every finding id the package can emit has a catalog entry', () => {
    const emitted = ['spf-missing', 'spf-permerror', 'spf-over-10-lookups', 'multiple-spf', 'spf-open', 'spf-no-all', 'dmarc-missing', 'dmarc-multiple',
      'dmarc-invalid', 'dmarc-p-none-no-rua', 'dkim-not-found-for-sender', 'mta-sts-missing',
      'bimi-missing', 'bimi-blocked-by-dmarc-none', 'bimi-blocked-by-dmarc-pct', 'bimi-logo-invalid', 'bimi-no-certificate'];
    expect(Object.keys(CATALOG).sort()).toEqual([...emitted].sort());
  });

  it('provider and DNS host keys are dns-checks ids (KTD13)', () => {
    const providerIds = new Set(PROVIDERS.map(p => p.id));
    const hostIds = new Set(DNS_HOSTS.map(h => h.id));
    for (const [name, data] of Object.entries(CATALOG)) {
      for (const e of data.entries) {
        expect(e.provider === '*' || providerIds.has(e.provider), `${name} provider ${e.provider}`).toBe(true);
        expect(e.dns_host === '*' || hostIds.has(e.dns_host), `${name} dns_host ${e.dns_host}`).toBe(true);
        for (const pid of Object.keys(e.provider_hints ?? {})) expect(providerIds.has(pid), `${name} hint ${pid}`).toBe(true);
      }
    }
    for (const key of Object.keys(DNS_HOST_STEPS.hosts)) expect(key === 'generic' || hostIds.has(key)).toBe(true);
  });
});

describe('BIMI fixes (test_bimi.py)', () => {
  const enforced = (o: RecOptions = {}) => makeRec('brand.com', {
    providers: [GOOGLE], spf: 'ok', spfRaw: 'v=spf1 include:_spf.google.com ~all', dmarc: 'found',
    dmarcRaw: 'v=DMARC1; p=reject; rua=mailto:r@brand.com', dmarcPolicy: 'reject', rua: ['mailto:r@brand.com'], ...o,
  });

  it('BIMI catalog entries have a fix, why and sources and are never exact', () => {
    for (const fid of ['bimi-missing', 'bimi-blocked-by-dmarc-none', 'bimi-blocked-by-dmarc-pct', 'bimi-logo-invalid', 'bimi-no-certificate']) {
      const e = CATALOG[fid].entries[0];
      expect(e.why && e.records.length && e.steps.length && e.sources.length).toBeTruthy();
      expect(e.exact).toBe(false);
    }
  });

  it('the enforcement fix keeps existing tags and is never inline-exact', () => {
    const f = fx(makeRec('brand.com', { providers: [GOOGLE], dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none; rua=mailto:r@brand.com; adkim=s', rua: ['mailto:r@brand.com'] }), 'bimi-blocked-by-dmarc-none');
    expect(f.records[0].value.startsWith('v=DMARC1; p=quarantine; pct=100;')).toBe(true);
    expect(f.records[0].value).toContain('adkim=s');
    expect(f.exact).toBe(false);
  });

  it('no DMARC record means no enforcement record is invented', () => {
    expect(fx(makeRec('brand.com', { providers: [GOOGLE] }), 'bimi-blocked-by-dmarc-none').records).toEqual([]);
  });

  it('the BIMI record template keeps placeholders', () => {
    const f = fx(enforced(), 'bimi-missing');
    expect(f.records[0].name).toBe('default._bimi.brand.com');
    expect(f.records[0].value).toContain('<https URL of your SVG logo>');
    expect(f.exact).toBe(false);
  });

  it('the enforcement fix drops a non-enforcing sp and keeps an enforcing one', () => {
    expect(enforcedDmarc('v=DMARC1; p=reject; sp=none; rua=mailto:a@b.com', 'b.com')).not.toContain('sp=');
    expect(enforcedDmarc('v=DMARC1; p=none; sp=none', 'b.com').startsWith('v=DMARC1; p=quarantine; pct=100;')).toBe(true);
    expect(enforcedDmarc('v=DMARC1; p=reject; sp=reject', 'b.com')).toContain('sp=reject');
  });

  it('certificate claims are sourced and do not overclaim Apple', () => {
    const e = CATALOG['bimi-no-certificate'].entries[0];
    const text = [e.why, ...e.steps].join(' ');
    for (const s of ['at least 12 months', 'registered trademark', 'Apple', 'does not say whether a CMC is accepted']) expect(text).toContain(s);
    expect(e.sources).toContain('https://developer.apple.com/support/bimi');
    expect(e.sources.some(x => x.includes('docs.digicert.com') && x.includes('common-mark'))).toBe(true);
    expect(fx(enforced({ bimi: bimiRec({ vmc: 'not-declared' }) }), 'bimi-no-certificate').catalog).toBe(true);
  });
});
