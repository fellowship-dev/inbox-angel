import { describe, it, expect } from 'vitest';
import { aggregate } from '../../tools/audit-fleet/lib/aggregate';
import type { DomainReport } from '../../tools/audit-fleet/lib/checker';

const rep = (domain: string, over: Partial<DomainReport> = {}): DomainReport => ({
  domain, checkedAt: 't', errors: [], exists: true, spf: { present: false }, dmarc: { present: false },
  dkim: { found: false, selectors: [] }, mx: { present: false, hosts: [] }, dnsHost: null, senders: [], mtaSts: false, ...over,
});

describe('aggregate', () => {
  const reports: DomainReport[] = [
    rep('a', { dmarc: { present: false }, spf: { present: false } }),
    rep('b', { dmarc: { present: true, policy: 'none', pct: 100, hasRua: true }, spf: { present: true, verdict: 'soft', lookups: 12, overLimit: true }, senders: ['Resend'], dnsHost: 'Cloudflare', mx: { present: true, hosts: ['x'], provider: 'Google Workspace' }, dkim: { found: true, selectors: ['resend'] } }),
    rep('c', { dmarc: { present: true, policy: 'reject', pct: 100 }, spf: { present: true, verdict: 'strict', lookups: 2, overLimit: false }, senders: ['Resend'], dnsHost: 'Cloudflare' }),
    rep('d', { dmarc: { present: true, policy: 'quarantine', pct: 50 }, spf: { present: true, verdict: 'soft' }, dnsHost: 'Cloudflare' }),
    rep('gone', { exists: false }),
    rep('flaky', { errors: ['txt:timeout'] }),
    rep('dkimflaky', { errors: ['dkim:timeout'] }),
  ];
  const agg = aggregate(reports, new Date('2026-01-01T00:00:00Z'), 2);

  it('excludes nonexistent and unreliable domains from the base, but not dkim-probe errors', () => {
    expect(agg.totals).toEqual({ domains: 7, nonexistent: 1, unreliable: 1, analysed: 5 });
  });
  it('computes dmarc and spf shares over the analysed base', () => {
    expect(agg.dmarc.missing).toEqual({ count: 2, pct: 40 });
    expect(agg.dmarc.p_none).toEqual({ count: 1, pct: 20 });
    expect(agg.dmarc.enforcing).toEqual({ count: 2, pct: 40 });
    expect(agg.dmarc.enforcing_full_pct).toEqual({ count: 1, pct: 20 });
    expect(agg.spf.over_10_lookups).toEqual({ count: 1, pct: 20 });
    expect(agg.dkim.found).toEqual({ count: 1, pct: 20 });
  });
  it('tabulates senders/dns hosts and folds small groups', () => {
    expect(agg.senders.Resend).toEqual({ count: 2, pct: 40 });
    expect(agg.dnsHosts.Cloudflare.count).toBe(3);
    expect(agg.dnsHosts['other (<2)']).toBeUndefined(); // unknown=2 is not < minCell(2)
    expect(agg.dnsHosts.unknown.count).toBe(2);
    const strict = aggregate(reports, new Date(), 3);
    expect(strict.mxProviders['other (<3)']).toBeDefined();
  });
  it('reports the domain-level error rate', () => {
    expect(agg.errors).toEqual({ domainsWithAnyError: 2, domainRate: 28.6 });
  });
  it('handles empty input', () => {
    expect(aggregate([]).totals.analysed).toBe(0);
  });
});
