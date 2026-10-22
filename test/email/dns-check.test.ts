import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSpfRecord,
  parseDkimRecord,
  parseDmarcRecord,
  lookupSpf,
  lookupDkim,
  lookupDmarc,
  checkDomain,
  DnsLookupError,
  countSpfLookupsFromRecord,
} from '../../src/email/dns-check';

// ── Pure parsing tests (no network) ──────────────────────────

describe('parseSpfRecord', () => {
  it('detects -all as strict', () => {
    const r = parseSpfRecord('v=spf1 include:sendgrid.net -all');
    expect(r.verdict).toBe('strict');
    expect(r.mechanisms).toContain('include:sendgrid.net');
    expect(r.mechanisms).toContain('-all');
  });

  it('detects ~all as soft', () => {
    const r = parseSpfRecord('v=spf1 ip4:1.2.3.4 ~all');
    expect(r.verdict).toBe('soft');
  });

  it('detects +all as open', () => {
    const r = parseSpfRecord('v=spf1 +all');
    expect(r.verdict).toBe('open');
  });

  it('detects ?all as open', () => {
    const r = parseSpfRecord('v=spf1 ?all');
    expect(r.verdict).toBe('open');
  });

  it('returns missing verdict if no all mechanism', () => {
    const r = parseSpfRecord('v=spf1 include:_spf.google.com');
    expect(r.verdict).toBe('missing');
  });

  it('lowercases mechanisms', () => {
    const r = parseSpfRecord('v=spf1 IP4:10.0.0.1 -ALL');
    expect(r.mechanisms).toContain('ip4:10.0.0.1');
    expect(r.mechanisms).toContain('-all');
  });

  it('preserves raw string', () => {
    const raw = 'v=spf1 include:mailgun.org -all';
    expect(parseSpfRecord(raw).raw).toBe(raw);
  });
});

describe('parseDkimRecord', () => {
  it('parses v=DKIM1 and k=rsa', () => {
    const raw = 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ==';
    const r = parseDkimRecord(raw);
    expect(r.version).toBe('DKIM1');
    expect(r.keyType).toBe('rsa');
    expect(r.present).toBe(true);
  });

  it('defaults keyType to rsa when k tag missing', () => {
    const raw = 'v=DKIM1; p=MIIB';
    const r = parseDkimRecord(raw);
    expect(r.keyType).toBe('rsa');
  });

  it('parses ed25519 key type', () => {
    const raw = 'v=DKIM1; k=ed25519; p=publickey';
    expect(parseDkimRecord(raw).keyType).toBe('ed25519');
  });

  it('marks present=true always', () => {
    expect(parseDkimRecord('v=DKIM1; p=abc').present).toBe(true);
  });

  it('preserves raw string', () => {
    const raw = 'v=DKIM1; k=rsa; p=abc';
    expect(parseDkimRecord(raw).raw).toBe(raw);
  });
});

describe('parseDmarcRecord', () => {
  it('parses a reject policy with rua and ruf', () => {
    const raw = 'v=DMARC1; p=reject; pct=100; rua=mailto:dmarc@example.com; ruf=mailto:ruf@example.com';
    const r = parseDmarcRecord(raw);
    expect(r.policy).toBe('reject');
    expect(r.subdomainPolicy).toBe('reject'); // defaults to p
    expect(r.pct).toBe(100);
    expect(r.rua).toEqual(['mailto:dmarc@example.com']);
    expect(r.ruf).toEqual(['mailto:ruf@example.com']);
  });

  it('parses quarantine with sp override', () => {
    const raw = 'v=DMARC1; p=quarantine; sp=none; pct=50';
    const r = parseDmarcRecord(raw);
    expect(r.policy).toBe('quarantine');
    expect(r.subdomainPolicy).toBe('none');
    expect(r.pct).toBe(50);
  });

  it('defaults pct to 100 when missing', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none');
    expect(r.pct).toBe(100);
  });

  it('returns empty arrays for rua/ruf when missing', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none');
    expect(r.rua).toEqual([]);
    expect(r.ruf).toEqual([]);
  });

  it('parses multiple rua addresses', () => {
    const raw = 'v=DMARC1; p=none; rua=mailto:a@example.com,mailto:b@example.com';
    const r = parseDmarcRecord(raw);
    expect(r.rua).toHaveLength(2);
    expect(r.rua).toContain('mailto:a@example.com');
  });

  it('preserves raw string', () => {
    const raw = 'v=DMARC1; p=reject';
    expect(parseDmarcRecord(raw).raw).toBe(raw);
  });
});

// ── Network tests (mocked fetch) ─────────────────────────────

function makeDohResponse(txtRecords: string[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        Status: 0,
        Answer: txtRecords.map(data => ({ type: 16, data: `"${data}"` })),
      }),
  } as unknown as Response;
}

function dohStatus(Status: number) {
  return { ok: true, status: 200, json: () => Promise.resolve({ Status }) } as unknown as Response;
}

const emptyDohResponse = {
  ok: true,
  json: () => Promise.resolve({ Status: 0 }),
} as unknown as Response;

describe('lookupSpf', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed SPF record when TXT includes v=spf1', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      url.toString().includes('name=sendgrid.net') ? makeDohResponse(['v=spf1 ip4:1.2.3.4 -all']) : makeDohResponse(['v=spf1 include:sendgrid.net -all']));
    const r = await lookupSpf('example.com');
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('strict');
  });

  it('returns null when no SPF TXT record found', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeDohResponse(['v=DMARC1; p=none'])
    );
    const r = await lookupSpf('example.com');
    expect(r).toBeNull();
  });

  it('THROWS (never returns null) on fetch failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network error'));
    await expect(lookupSpf('example.com')).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('returns null for NXDOMAIN', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(dohStatus(3));
    expect(await lookupSpf('example.com')).toBeNull();
  });

  it.each([2, 5])('throws on RCODE %i', async rcode => {
    vi.mocked(fetch).mockResolvedValueOnce(dohStatus(rcode));
    await expect(lookupSpf('example.com')).rejects.toThrow(/SPF lookup/);
  });

  it('throws on a DoH HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) } as unknown as Response);
    await expect(lookupSpf('example.com')).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('throws on a malformed answer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ Status: 0, Answer: 'x' }) } as unknown as Response);
    await expect(lookupSpf('example.com')).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('throws when the SPF record includes a domain whose lookup fails', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      url.toString().includes('name=example.com') ? makeDohResponse(['v=spf1 include:broken.test -all']) : dohStatus(2));
    await expect(lookupSpf('example.com')).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('reports the RFC lookup count on the record', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = url.toString();
      if (u.includes('name=example.com')) return makeDohResponse(['v=spf1 include:a.test ip4:1.2.3.4 mx -all']);
      if (u.includes('name=a.test')) return makeDohResponse(['v=spf1 ip4:5.6.7.8 -all']);
      return makeDohResponse(['10 mx.example.com.']);
    });
    const r = await lookupSpf('example.com');
    expect(r!.lookup_count).toBe(2); // include + mx (ip4/all free)
  });

  it('flags multiple SPF records as an error rather than picking one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeDohResponse(['v=spf1 -all', 'v=spf1 +all']));
    await expect(lookupSpf('example.com')).rejects.toThrow(/SPF lookup/);
  });

  it('strips quotes from DoH response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeDohResponse(['v=spf1 ~all']));
    const r = await lookupSpf('example.com');
    expect(r!.raw).toBe('v=spf1 ~all'); // no surrounding quotes
  });
});

describe('lookupDkim', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('queries selector._domainkey.domain', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(makeDohResponse(['v=DKIM1; k=rsa; p=ABC']));
    const r = await lookupDkim('example.com', 'selector1');
    expect(r).not.toBeNull();
    expect(r!.present).toBe(true);
    // Verify correct DNS name was used
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('selector1._domainkey.example.com');
  });

  it('returns null when no DKIM record found', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(emptyDohResponse);
    const r = await lookupDkim('example.com', 'missing-sel');
    expect(r).toBeNull();
  });

  it('finds record with only k= tag (no v=DKIM1)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeDohResponse(['k=rsa; p=MIIB']));
    const r = await lookupDkim('example.com', 'sel');
    expect(r).not.toBeNull();
  });
});

describe('lookupDkim errors', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('throws on SERVFAIL, null on NXDOMAIN', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(dohStatus(2));
    await expect(lookupDkim('example.com', 's')).rejects.toBeInstanceOf(DnsLookupError);
    vi.mocked(fetch).mockResolvedValueOnce(dohStatus(3));
    expect(await lookupDkim('example.com', 's')).toBeNull();
  });
});

describe('countSpfLookupsFromRecord', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('counts per RFC 7208 and throws on DNS failure', async () => {
    vi.mocked(fetch).mockResolvedValue(makeDohResponse(['v=spf1 ip4:1.1.1.1 -all']));
    expect(await countSpfLookupsFromRecord('v=spf1 include:a.test ip4:1.2.3.4 ptr -all')).toBe(2);
    vi.mocked(fetch).mockResolvedValue(dohStatus(2));
    await expect(countSpfLookupsFromRecord('v=spf1 include:a.test -all')).rejects.toBeInstanceOf(DnsLookupError);
  });
});

describe('lookupDmarc', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns DMARC record from _dmarc.domain', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(makeDohResponse(['v=DMARC1; p=quarantine; pct=100']));
    const r = await lookupDmarc('example.com');
    expect(r).not.toBeNull();
    expect(r!.policy).toBe('quarantine');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('_dmarc.example.com');
  });

  it('falls back to org domain for subdomains', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(emptyDohResponse) // _dmarc.mail.example.com — miss
      .mockResolvedValueOnce(makeDohResponse(['v=DMARC1; p=reject'])); // _dmarc.example.com — hit
    const r = await lookupDmarc('mail.example.com');
    expect(r).not.toBeNull();
    expect(r!.policy).toBe('reject');
  });

  it('uses the Public Suffix List for the org-domain fallback (never co.uk)', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation(async (url) =>
      url.toString().includes('name=_dmarc.example.co.uk')
        ? makeDohResponse(['v=DMARC1; p=reject'])
        : url.toString().includes('name=_dmarc.co.uk')
          ? makeDohResponse(['v=DMARC1; p=none'])
          : dohStatus(3));
    const r = await lookupDmarc('mail.example.co.uk');
    expect(r!.policy).toBe('reject');
    expect(mockFetch.mock.calls.map(c => c[0] as string).some(u => u.includes('name=_dmarc.co.uk'))).toBe(false);
  });

  it('throws on a DNS error instead of returning null', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(dohStatus(2));
    await expect(lookupDmarc('example.com')).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('throws on a DNS error during the org-domain fallback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(dohStatus(3)).mockResolvedValueOnce(dohStatus(2));
    await expect(lookupDmarc('mail.example.com')).rejects.toBeInstanceOf(DnsLookupError);
  });

  it('returns null when no DMARC record anywhere', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(emptyDohResponse)
      .mockResolvedValueOnce(emptyDohResponse);
    const r = await lookupDmarc('example.com');
    expect(r).toBeNull();
  });
});

describe('checkDomain', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  function mockByName(map: Record<string, Response>) {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const name = new URL(url.toString()).searchParams.get('name')!;
      return map[name] ?? dohStatus(3);
    });
  }

  it('runs all three lookups and returns the combined result', async () => {
    mockByName({
      'example.com': makeDohResponse(['v=spf1 -all']),
      '_dmarc.example.com': makeDohResponse(['v=DMARC1; p=reject']),
      'sel._domainkey.example.com': makeDohResponse(['v=DKIM1; k=rsa; p=X']),
    });
    const result = await checkDomain('example.com', 'sel');
    expect(result.domain).toBe('example.com');
    expect(result.spf!.verdict).toBe('strict');
    expect(result.dmarc!.policy).toBe('reject');
    expect(result.dkim!.present).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('skips DKIM lookup when no selector provided', async () => {
    mockByName({ 'example.com': makeDohResponse(['v=spf1 ~all']) });
    const result = await checkDomain('example.com');
    expect(result.dkim).toBeNull();
    const urls = vi.mocked(fetch).mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes('_domainkey'))).toBe(false);
  });

  it('records which lookups FAILED instead of reporting them as missing', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const name = new URL(url.toString()).searchParams.get('name')!;
      if (name === 'example.com') throw new Error('timeout');
      return dohStatus(3);
    });
    const result = await checkDomain('example.com');
    expect(result.spf).toBeNull();
    expect(result.errors?.spf).toMatch(/timeout/);
    expect(result.dmarc).toBeNull();
    expect(result.errors?.dmarc).toBeUndefined(); // genuinely absent: NXDOMAIN
  });

  it('a DMARC SERVFAIL is an error, not "no DMARC"', async () => {
    mockByName({ 'example.com': makeDohResponse(['v=spf1 -all']), '_dmarc.example.com': dohStatus(2) });
    const result = await checkDomain('example.com');
    expect(result.errors?.dmarc).toMatch(/SERVFAIL/);
  });
});
