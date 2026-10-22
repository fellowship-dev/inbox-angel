import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSubscription } from '../../src/monitor/check';
import type { MonitorSubscription } from '../../src/db/types';

function makeSub(overrides: Partial<MonitorSubscription> = {}): MonitorSubscription {
  return {
    id: 1,
    email: 'test@example.com',
    domain: 'acme.com',
    session_token: 'tok',
    spf_record: 'v=spf1 include:_spf.google.com -all',
    dmarc_policy: 'none',
    dmarc_pct: 100,
    dmarc_record: 'v=DMARC1; p=none; pct=100',
    active: 1,
    last_checked_at: null,
    created_at: 0,
    ...overrides,
  };
}

type Dns = string | null | 'SERVFAIL';

function mockDns(spfRaw: Dns, dmarcRaw: Dns) {
  vi.mocked(fetch).mockImplementation(async (url) => {
    const name = new URL(url.toString()).searchParams.get('name')!;
    const body = (raw: Dns) =>
      raw === 'SERVFAIL'
        ? { Status: 2 }
        : { Status: 0, ...(raw ? { Answer: [{ type: 16, data: `"${raw}"` }] } : {}) };
    if (name.startsWith('_dmarc.')) return new Response(JSON.stringify(body(dmarcRaw)), { status: 200 });
    if (name === 'acme.com') return new Response(JSON.stringify(body(spfRaw)), { status: 200 });
    // include targets
    return new Response(JSON.stringify(body('v=spf1 ip4:192.0.2.1 -all')), { status: 200 });
  });
}

describe('checkSubscription', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns no changes when DNS matches baseline', async () => {
    mockDns('v=spf1 include:_spf.google.com -all', 'v=DMARC1; p=none; pct=100');
    const result = await checkSubscription(makeSub());
    expect(result.changes).toHaveLength(0);
  });

  it('detects SPF record change', async () => {
    mockDns('v=spf1 include:sendgrid.net -all', 'v=DMARC1; p=none; pct=100');
    const result = await checkSubscription(makeSub());
    const spfChange = result.changes.find(c => c.field === 'SPF record');
    expect(spfChange).toBeDefined();
    expect(spfChange!.was).toContain('google.com');
    expect(spfChange!.now).toContain('sendgrid.net');
  });

  it('detects DMARC policy upgrade as improved', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=reject; pct=100');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'none' }));
    const change = result.changes.find(c => c.field === 'DMARC policy');
    expect(change).toBeDefined();
    expect(change!.severity).toBe('improved');
    expect(change!.now).toBe('reject');
  });

  it('detects DMARC policy downgrade as degraded', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=none; pct=100');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'reject' }));
    const change = result.changes.find(c => c.field === 'DMARC policy');
    expect(change!.severity).toBe('degraded');
  });

  it('detects DMARC pct decrease as degraded', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=reject; pct=50');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'reject', dmarc_pct: 100 }));
    const change = result.changes.find(c => c.field === 'DMARC enforcement %');
    expect(change!.severity).toBe('degraded');
    expect(change!.was).toBe('100%');
    expect(change!.now).toBe('50%');
  });

  it('does not report pct change when policy is none', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=none; pct=50');
    const result = await checkSubscription(makeSub({ dmarc_policy: 'none', dmarc_pct: 100 }));
    expect(result.changes.find(c => c.field === 'DMARC enforcement %')).toBeUndefined();
  });

  it('detects SPF removal as degraded', async () => {
    mockDns(null, 'v=DMARC1; p=none');
    const result = await checkSubscription(makeSub());
    const change = result.changes.find(c => c.field === 'SPF record');
    expect(change!.severity).toBe('degraded');
    expect(change!.now).toBe('');
  });

  it('returns newBaseline reflecting current DNS', async () => {
    mockDns('v=spf1 include:new.com -all', 'v=DMARC1; p=quarantine; pct=80');
    const result = await checkSubscription(makeSub());
    expect(result.newBaseline.spf_record).toContain('new.com');
    expect(result.newBaseline.dmarc_policy).toBe('quarantine');
    expect(result.newBaseline.dmarc_pct).toBe(80);
  });

  it('handles null baselines gracefully (first check)', async () => {
    mockDns('v=spf1 -all', 'v=DMARC1; p=reject');
    const result = await checkSubscription(makeSub({ spf_record: null, dmarc_policy: null, dmarc_record: null }));
    // SPF appeared = improved
    const spfChange = result.changes.find(c => c.field === 'SPF record');
    expect(spfChange!.severity).toBe('improved');
  });

  describe('DNS failures are not "record removed"', () => {
    it('SPF SERVFAIL: no change reported, baseline preserved, error surfaced', async () => {
      mockDns('SERVFAIL', 'v=DMARC1; p=none; pct=100');
      const sub = makeSub();
      const result = await checkSubscription(sub);
      expect(result.changes).toHaveLength(0);
      expect(result.newBaseline.spf_record).toBe(sub.spf_record);
      expect(result.errors.spf).toMatch(/SERVFAIL/);
      expect(result.errors.dmarc).toBeUndefined();
    });

    it('DMARC SERVFAIL: policy downgrade NOT reported, baseline preserved', async () => {
      mockDns('v=spf1 include:_spf.google.com -all', 'SERVFAIL');
      const sub = makeSub({ dmarc_policy: 'reject', dmarc_pct: 100, dmarc_record: 'v=DMARC1; p=reject' });
      const result = await checkSubscription(sub);
      expect(result.changes.find(c => c.field.startsWith('DMARC'))).toBeUndefined();
      expect(result.newBaseline).toMatchObject({ dmarc_policy: 'reject', dmarc_pct: 100, dmarc_record: 'v=DMARC1; p=reject' });
      expect(result.errors.dmarc).toBeDefined();
    });

    it('a network failure on one check still lets the other be diffed', async () => {
      vi.mocked(fetch).mockImplementation(async (url) => {
        const name = new URL(url.toString()).searchParams.get('name')!;
        if (name === 'acme.com') throw new Error('timeout');
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v=DMARC1; p=reject; pct=100"' }] }), { status: 200 });
      });
      const result = await checkSubscription(makeSub({ dmarc_policy: 'none' }));
      expect(result.errors.spf).toMatch(/timeout/);
      expect(result.changes.map(c => c.field)).toEqual(['DMARC policy']);
    });

    it('genuinely removed records (NXDOMAIN) are still reported', async () => {
      vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 }));
      const result = await checkSubscription(makeSub());
      expect(result.errors).toEqual({});
      expect(result.changes.find(c => c.field === 'SPF record')?.severity).toBe('degraded');
      expect(result.changes.find(c => c.field === 'DMARC policy')?.severity).toBe('degraded');
    });
  });
});
