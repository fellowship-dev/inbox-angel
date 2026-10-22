import { describe, it, expect, vi, beforeEach } from 'vitest';

import { provisionDomain, deprovisionDomain, DnsProvisionError } from '../../src/dns/provision';
import { makeTenant } from '../helpers/tenant';

/** A tenant whose reports domain (reports.inboxangel.io) sits in the already-known zone-abc. */
const ENV = makeTenant({
  cfToken: 'test-token',
  settings: { reportsDomain: 'reports.inboxangel.io', zoneId: 'zone-abc', zoneName: 'inboxangel.io' },
});

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status })
  ));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ── provisionDomain ───────────────────────────────────────────

describe('provisionDomain', () => {
  it('returns recordId and recordName on success', async () => {
    mockFetch(200, { success: true, result: { id: 'dns-record-1' } });
    const result = await provisionDomain(ENV, 'acme.com');
    expect(result.recordId).toBe('dns-record-1');
    expect(result.recordName).toBe('acme.com._report._dmarc.reports.inboxangel.io');
  });

  it('POSTs to the correct CF API endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { id: 'rec-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await provisionDomain(ENV, 'example.com');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-abc/dns_records');
    expect(opts.method).toBe('POST');
  });

  it('sends correct TXT record payload', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true, result: { id: 'rec-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await provisionDomain(ENV, 'example.com');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.type).toBe('TXT');
    expect(body.name).toBe('example.com._report._dmarc.reports.inboxangel.io');
    expect(body.content).toBe('v=DMARC1;');
  });

  it('includes Authorization header', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true, result: { id: 'r' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await provisionDomain(ENV, 'acme.com');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
  });

  it('throws DnsProvisionError when CF returns success=false', async () => {
    mockFetch(200, { success: false, errors: [{ message: 'invalid zone' }] });
    await expect(provisionDomain(ENV, 'acme.com')).rejects.toThrow(DnsProvisionError);
  });

  it('includes CF error message in DnsProvisionError', async () => {
    mockFetch(200, { success: false, errors: [{ message: 'invalid zone' }] });
    await expect(provisionDomain(ENV, 'acme.com')).rejects.toThrow('invalid zone');
  });

  it('throws DnsProvisionError when CF returns non-ok status', async () => {
    mockFetch(403, { success: false, errors: [{ message: 'forbidden' }] });
    await expect(provisionDomain(ENV, 'acme.com')).rejects.toThrow(DnsProvisionError);
  });

  it('throws DnsProvisionError when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(provisionDomain(ENV, 'acme.com')).rejects.toThrow(DnsProvisionError);
    await expect(provisionDomain(ENV, 'acme.com')).rejects.toThrow('DNS provision fetch failed');
  });

  it('returns manual result when CF credentials are not configured', async () => {
    const bare = makeTenant({ settings: { reportsDomain: 'r.io' } });
    const result = await provisionDomain(bare, 'acme.com');
    expect(result.manual).toBe(true);
    expect(result.recordId).toBeNull();
    expect(result.recordName).toBe('acme.com._report._dmarc.r.io');
  });

  it('writes into the reports domain\'s zone, looked up by name when not already known', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })) // reports.other.io: not a zone
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: [{ id: 'zone-lookup', name: 'other.io' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: 'rec-9' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tenant = makeTenant({ cfToken: 'tok', settings: { reportsDomain: 'reports.other.io' } });
    const result = await provisionDomain(tenant, 'acme.com');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/zones?name=reports.other.io');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.cloudflare.com/client/v4/zones?name=other.io');
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.cloudflare.com/client/v4/zones/zone-lookup/dns_records');
    expect(result.recordId).toBe('rec-9');
  });

  it('falls back to manual mode when the token has no zone for the reports domain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })));
    const tenant = makeTenant({ cfToken: 'tok', settings: { reportsDomain: 'reports.nozone.io' } });
    const result = await provisionDomain(tenant, 'acme.com');
    expect(result).toMatchObject({ manual: true, recordId: null });
  });
});

// ── deprovisionDomain ─────────────────────────────────────────

describe('deprovisionDomain', () => {
  it('DELETEs the correct CF API endpoint', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deprovisionDomain(ENV, 'dns-record-1');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-abc/dns_records/dns-record-1');
    expect(opts.method).toBe('DELETE');
  });

  it('resolves without throwing on 404 (idempotent)', async () => {
    mockFetch(404, { success: false, errors: [{ message: 'not found' }] });
    await expect(deprovisionDomain(ENV, 'gone-id')).resolves.toBeUndefined();
  });

  it('resolves without throwing when fetch fails (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(deprovisionDomain(ENV, 'some-id')).resolves.toBeUndefined();
  });

  it('resolves without calling fetch when credentials are not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await deprovisionDomain(makeTenant(), 'some-id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
