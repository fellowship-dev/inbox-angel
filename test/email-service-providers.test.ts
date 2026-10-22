import { describe, it, expect } from 'vitest';
import { SPF_PROVIDERS, DKIM_ONLY_PROVIDERS, detectProviders, matchDkimProvider, findUnsignedSpfProviders, getAllDkimSelectors } from '@inbox-angel/dns-checks/email-service-providers';
import { extractIncludes, extractOtherMechanisms, buildSpfRecord } from '@inbox-angel/dns-checks/spf-record';

describe('SPF_PROVIDERS', () => {
  it('has at least 15 known providers', () => {
    expect(SPF_PROVIDERS.length).toBeGreaterThanOrEqual(15);
  });

  it('each provider has include and name', () => {
    for (const p of SPF_PROVIDERS) {
      expect(p.include).toBeTruthy();
      expect(p.name).toBeTruthy();
    }
  });

  it('has no duplicate includes', () => {
    const includes = SPF_PROVIDERS.map(p => p.include);
    expect(new Set(includes).size).toBe(includes.length);
  });

  it('providers with dkimSelectors have dkimGuideUrl', () => {
    for (const p of [...SPF_PROVIDERS, ...DKIM_ONLY_PROVIDERS]) {
      if (p.dkimSelectors && p.dkimSelectors.length > 0) {
        expect(p.dkimGuideUrl, `${p.name} missing dkimGuideUrl`).toBeTruthy();
      }
    }
  });
});

describe('detectProviders', () => {
  it('detects Google Workspace from SPF record', () => {
    const record = 'v=spf1 include:_spf.google.com ~all';
    const detected = detectProviders(record);
    expect(detected).toHaveLength(1);
    expect(detected[0].name).toBe('Google Workspace');
  });

  it('detects multiple providers', () => {
    const record = 'v=spf1 include:_spf.google.com include:sendgrid.net include:amazonses.com ~all';
    const detected = detectProviders(record);
    expect(detected).toHaveLength(3);
    expect(detected.map(p => p.name)).toEqual(['Google Workspace', 'SendGrid', 'Amazon SES']);
  });

  it('returns empty for record with no known providers', () => {
    const record = 'v=spf1 include:custom.example.com ~all';
    expect(detectProviders(record)).toHaveLength(0);
  });

  it('returns empty for empty string', () => {
    expect(detectProviders('')).toHaveLength(0);
  });

  it('does not false-match partial includes', () => {
    const record = 'v=spf1 include:google.com ~all';
    expect(detectProviders(record)).toHaveLength(0);
  });
});

describe('extractIncludes', () => {
  it('extracts all include mechanisms', () => {
    const record = 'v=spf1 include:_spf.google.com include:sendgrid.net ~all';
    expect(extractIncludes(record)).toEqual(['_spf.google.com', 'sendgrid.net']);
  });

  it('returns empty for record with no includes', () => {
    expect(extractIncludes('v=spf1 ip4:192.168.1.0/24 ~all')).toEqual([]);
  });

  it('handles single include', () => {
    expect(extractIncludes('v=spf1 include:_spf.google.com -all')).toEqual(['_spf.google.com']);
  });

  it('handles empty string', () => {
    expect(extractIncludes('')).toEqual([]);
  });
});

describe('extractOtherMechanisms', () => {
  it('extracts mx mechanism', () => {
    expect(extractOtherMechanisms('v=spf1 include:_spf.protonmail.ch mx ~all')).toEqual(['mx']);
  });

  it('extracts ip4 and ip6', () => {
    expect(extractOtherMechanisms('v=spf1 ip4:192.168.1.0/24 ip6:2001:db8::/32 ~all')).toEqual(['ip4:192.168.1.0/24', 'ip6:2001:db8::/32']);
  });

  it('extracts redirect', () => {
    expect(extractOtherMechanisms('v=spf1 redirect=example.com')).toEqual(['redirect=example.com']);
  });

  it('returns empty when only includes and all', () => {
    expect(extractOtherMechanisms('v=spf1 include:_spf.google.com ~all')).toEqual([]);
  });

  it('handles a mechanism', () => {
    expect(extractOtherMechanisms('v=spf1 a include:_spf.google.com ~all')).toEqual(['a']);
  });
});

describe('buildSpfRecord', () => {
  it('builds record with single include', () => {
    expect(buildSpfRecord(['_spf.google.com'])).toBe('v=spf1 include:_spf.google.com ~all');
  });

  it('builds record with multiple includes', () => {
    expect(buildSpfRecord(['_spf.google.com', 'sendgrid.net'])).toBe(
      'v=spf1 include:_spf.google.com include:sendgrid.net ~all'
    );
  });

  it('defaults to ~all qualifier', () => {
    expect(buildSpfRecord(['_spf.google.com'])).toContain('~all');
  });

  it('supports -all qualifier', () => {
    expect(buildSpfRecord(['_spf.google.com'], '-all')).toBe('v=spf1 include:_spf.google.com -all');
  });

  it('builds empty record with just qualifier', () => {
    expect(buildSpfRecord([])).toBe('v=spf1 ~all');
  });

  it('preserves other mechanisms', () => {
    expect(buildSpfRecord(['_spf.protonmail.ch'], '~all', ['mx'])).toBe('v=spf1 include:_spf.protonmail.ch mx ~all');
  });

  it('preserves ip4 mechanisms', () => {
    expect(buildSpfRecord(['_spf.google.com'], '~all', ['ip4:192.168.1.0/24'])).toBe('v=spf1 include:_spf.google.com ip4:192.168.1.0/24 ~all');
  });
});

describe('matchDkimProvider', () => {
  it('matches Google selector', () => {
    const provider = matchDkimProvider('google');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('Google Workspace');
  });

  it('matches with ._domainkey suffix', () => {
    const provider = matchDkimProvider('google._domainkey');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('Google Workspace');
  });

  it('matches with full FQDN (._domainkey.example.com)', () => {
    const provider = matchDkimProvider('google._domainkey.example.com');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('Google Workspace');
  });

  it('is case-insensitive', () => {
    const provider = matchDkimProvider('Google');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('Google Workspace');
  });

  it('matches DKIM-only providers', () => {
    const provider = matchDkimProvider('fm1');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('Fastmail');
  });

  it('matches Microsoft selector2 via SPF provider', () => {
    const provider = matchDkimProvider('selector2');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('Microsoft 365');
  });

  it('matches Proton Mail secondary selectors', () => {
    expect(matchDkimProvider('protonmail2')!.name).toBe('Proton Mail');
    expect(matchDkimProvider('protonmail3')!.name).toBe('Proton Mail');
  });

  it('returns null for unknown selector', () => {
    expect(matchDkimProvider('unknown-selector')).toBeNull();
  });
});

describe('findUnsignedSpfProviders', () => {
  it('returns empty when no SPF record', () => {
    expect(findUnsignedSpfProviders([], null)).toEqual([]);
  });

  it('returns SPF providers with no matching DKIM', () => {
    const spf = 'v=spf1 include:_spf.google.com include:sendgrid.net ~all';
    const selectors = [{ name: 'google', record: 'v=DKIM1; ...' }];
    const unsigned = findUnsignedSpfProviders(selectors, spf);
    expect(unsigned).toHaveLength(1);
    expect(unsigned[0].name).toBe('SendGrid');
  });

  it('returns empty when all SPF providers have DKIM', () => {
    const spf = 'v=spf1 include:_spf.google.com ~all';
    const selectors = [{ name: 'google', record: 'v=DKIM1; ...' }];
    expect(findUnsignedSpfProviders(selectors, spf)).toEqual([]);
  });

  it('flags providers with empty dkimSelectors as unsigned', () => {
    const spf = 'v=spf1 include:amazonses.com ~all';
    const selectors: { name: string; record: string }[] = [];
    const unsigned = findUnsignedSpfProviders(selectors, spf);
    expect(unsigned).toHaveLength(1);
    expect(unsigned[0].name).toBe('Amazon SES');
  });

  it('handles FQDN selector names (._domainkey.domain.com)', () => {
    const spf = 'v=spf1 include:_spf.protonmail.ch ~all';
    const selectors = [{ name: 'protonmail._domainkey.fellowship.dev', record: 'v=DKIM1; ...' }];
    expect(findUnsignedSpfProviders(selectors, spf)).toEqual([]);
  });

  it('matches any of a providers multiple selectors', () => {
    const spf = 'v=spf1 include:_spf.protonmail.ch ~all';
    // Only protonmail3 detected — should still count as signed
    const selectors = [{ name: 'protonmail3._domainkey.example.com', record: 'v=DKIM1; ...' }];
    expect(findUnsignedSpfProviders(selectors, spf)).toEqual([]);
  });
});

describe('getAllDkimSelectors', () => {
  it('returns a non-empty array', () => {
    const selectors = getAllDkimSelectors();
    expect(selectors.length).toBeGreaterThan(10);
  });

  it('has no duplicates', () => {
    const selectors = getAllDkimSelectors();
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  it('includes generic selectors', () => {
    const selectors = getAllDkimSelectors();
    expect(selectors).toContain('default');
    expect(selectors).toContain('dkim');
  });

  it('includes known ESP selectors', () => {
    const selectors = getAllDkimSelectors();
    expect(selectors).toContain('google');
    expect(selectors).toContain('selector1');
    expect(selectors).toContain('protonmail');
  });
});
