import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/index';

// Characterization tests for POST /api/domains/:id/apply-dmarc and the zone each
// DNS write lands in. They pin today's behaviour before the tenancy refactor.

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test' }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'auth-rec-1', recordName: 'x', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue('zone-default'),
    getAccountId: vi.fn().mockReturnValue('acct-test'),
    reportsDomain: vi.fn().mockReturnValue('reports.test.com'),
    fromEmail: vi.fn().mockReturnValue('noreply@reports.test.com'),
    getBaseDomain: vi.fn().mockReturnValue('test.com'),
    getWorkersSubdomain: vi.fn().mockReturnValue(undefined),
    resetEnvCache: vi.fn(),
  };
});

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { getZoneId } from '../../src/env-utils';
import { provisionDomain } from '../../src/dns/provision';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function makeEnv(domains: { id: number; domain: string; dns_record_id?: string }[], token: string | null = 'cf-token'): Env {
  const db = createMigratedD1();
  for (const d of domains) {
    db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id) VALUES (?, ?, ?, ?)')
      .run(d.id, d.domain, 'rua@reports.test.com', d.dns_record_id ?? null);
  }
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: token ?? undefined } as Env;
}

function applyDmarc(id: number, record = 'v=DMARC1; p=none; rua=mailto:rua@reports.test.com'): Request {
  return new Request(`https://x.test/api/domains/${id}/apply-dmarc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ record }),
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stubCf(search: unknown[], write = { success: true, result: { id: 'rec-new' } }) {
  const fn = vi.fn()
    .mockResolvedValueOnce(json({ success: true, result: search }))
    .mockResolvedValueOnce(json(write));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getZoneId).mockReturnValue('zone-default');
  vi.mocked(provisionDomain).mockClear();
});

describe('POST /api/domains/:id/apply-dmarc (characterization)', () => {
  it('creates _dmarc.{domain} TXT when none exists', async () => {
    const fetchMock = stubCf([]);
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true });

    const [searchUrl] = fetchMock.mock.calls[0] as [string];
    expect(searchUrl).toContain('/zones/zone-default/dns_records?type=TXT&name=_dmarc.acme.com');
    const [url, opts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-default/dns_records');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toMatchObject({ type: 'TXT', name: '_dmarc.acme.com', ttl: 3600 });
  });

  it('PATCHes the existing record in place', async () => {
    const fetchMock = stubCf([{ id: 'rec-old' }]);
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(await res.json()).toMatchObject({ ok: true, created: false });
    const [url, opts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone-default/dns_records/rec-old');
    expect(opts.method).toBe('PATCH');
  });

  it('surfaces a Cloudflare rejection as 500 with the CF message', async () => {
    stubCf([], { success: false, errors: [{ message: 'CF says no' }] } as never);
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'CF says no' });
  });

  it('400s without Cloudflare credentials, 404s for unknown domains, 400s without a record', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }], null), ctx)).status).toBe(400);
    expect((await handleApi(applyDmarc(9), makeEnv([]), ctx)).status).toBe(404);
    const noRecord = new Request('https://x.test/api/domains/1/apply-dmarc', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: '{}',
    });
    expect((await handleApi(noRecord, makeEnv([{ id: 1, domain: 'acme.com' }]), ctx)).status).toBe(400);
  });

  it('provisions the cross-domain auth record once, and skips it when one is already stored', async () => {
    stubCf([]);
    const fresh = makeEnv([{ id: 1, domain: 'acme.com' }]);
    const res = await handleApi(applyDmarc(1), fresh, ctx);
    expect(await res.json()).toMatchObject({ auth_record_provisioned: true });
    expect(provisionDomain).toHaveBeenCalledTimes(1);

    stubCf([]);
    await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com', dns_record_id: 'have-one' }]), ctx);
    expect(provisionDomain).toHaveBeenCalledTimes(1);
  });

  // KNOWN BUG (fixed later in this lane): every write goes to the one cached zone,
  // whatever the domain. A domain that lives in another zone is written to the wrong one.
  it('BUG: writes a domain from a different zone into the default zone', async () => {
    const fetchMock = stubCf([]);
    await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'other-company.org' }]), ctx);
    const [url] = fetchMock.mock.calls[1] as [string];
    expect(url).toContain('/zones/zone-default/');
  });
});
