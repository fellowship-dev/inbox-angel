import { describe, it, expect } from 'vitest';
import { getRecommendations, getAllRecommendations } from '../src/lib/pdf/recommendations';
import type { DomainCheckSummary } from '../src/lib/types';

function makeSummary(overrides: Partial<DomainCheckSummary> = {}): DomainCheckSummary {
  return {
    domain_id: 1,
    domain: 'example.com',
    dmarc_policy: 'reject',
    spf_record: 'v=spf1 include:_spf.example.com ~all',
    total_messages: 1000,
    pass_messages: 980,
    fail_messages: 20,
    dkim_total: 1000,
    dkim_pass: 970,
    spf_total: 1000,
    spf_pass: 960,
    mta_sts_enabled: 1,
    mta_sts_mode: 'enforce',
    ...overrides,
  };
}

describe('getRecommendations', () => {
  it('returns no recommendations for a fully healthy domain', () => {
    const recs = getRecommendations(makeSummary());
    expect(recs).toHaveLength(0);
  });

  it('returns critical recommendation for dmarc_policy = none', () => {
    const recs = getRecommendations(makeSummary({ dmarc_policy: 'none' }));
    const critical = recs.find((r) => r.severity === 'critical' && r.message.includes('none'));
    expect(critical).toBeDefined();
  });

  it('returns warning recommendation for dmarc_policy = quarantine', () => {
    const recs = getRecommendations(makeSummary({ dmarc_policy: 'quarantine' }));
    const warning = recs.find((r) => r.severity === 'warning' && r.message.includes('quarantine'));
    expect(warning).toBeDefined();
  });

  it('returns no dmarc policy rec for reject policy', () => {
    const recs = getRecommendations(makeSummary({ dmarc_policy: 'reject' }));
    expect(recs.every((r) => !r.message.includes('policy'))).toBe(true);
  });

  it('returns critical for very low dmarc pass rate (<70%)', () => {
    const recs = getRecommendations(makeSummary({ pass_messages: 600, total_messages: 1000 }));
    const critical = recs.find((r) => r.severity === 'critical' && r.message.includes('60%'));
    expect(critical).toBeDefined();
  });

  it('returns warning for moderately low dmarc pass rate (70-95%)', () => {
    const recs = getRecommendations(makeSummary({ pass_messages: 800, total_messages: 1000 }));
    const warning = recs.find((r) => r.severity === 'warning' && r.message.includes('80%'));
    expect(warning).toBeDefined();
  });

  it('returns info when no messages received', () => {
    const recs = getRecommendations(makeSummary({ total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, spf_total: 0 }));
    const info = recs.find((r) => r.severity === 'info' && r.message.includes('No DMARC reports'));
    expect(info).toBeDefined();
  });

  it('returns info when MTA-STS is disabled', () => {
    const recs = getRecommendations(makeSummary({ mta_sts_enabled: 0 }));
    const info = recs.find((r) => r.severity === 'info' && r.message.includes('MTA-STS'));
    expect(info).toBeDefined();
  });

  it('returns warning for low SPF pass rate', () => {
    const recs = getRecommendations(makeSummary({ spf_pass: 800, spf_total: 1000 }));
    const warning = recs.find((r) => r.severity === 'warning' && r.message.includes('SPF'));
    expect(warning).toBeDefined();
  });

  it('returns warning for low DKIM pass rate', () => {
    const recs = getRecommendations(makeSummary({ dkim_pass: 800, dkim_total: 1000 }));
    const warning = recs.find((r) => r.severity === 'warning' && r.message.includes('DKIM'));
    expect(warning).toBeDefined();
  });

  it('all recommendations include domain name', () => {
    const summary = makeSummary({ dmarc_policy: 'none', mta_sts_enabled: 0 });
    const recs = getRecommendations(summary);
    for (const r of recs) {
      expect(r.domain).toBe('example.com');
    }
  });
});

describe('getAllRecommendations', () => {
  it('flattens recommendations from multiple domains', () => {
    const summaries = [
      makeSummary({ domain: 'a.com', dmarc_policy: 'none' }),
      makeSummary({ domain: 'b.com', mta_sts_enabled: 0 }),
    ];
    const recs = getAllRecommendations(summaries);
    expect(recs.some((r) => r.domain === 'a.com')).toBe(true);
    expect(recs.some((r) => r.domain === 'b.com')).toBe(true);
  });

  it('returns empty array for all-healthy domains', () => {
    const recs = getAllRecommendations([makeSummary(), makeSummary({ domain_id: 2, domain: 'b.com' })]);
    expect(recs).toHaveLength(0);
  });
});
