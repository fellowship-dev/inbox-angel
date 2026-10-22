import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';

// POST /api/domains/:id/apply-dmarc: the record is written to the zone of *that* domain.

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', accountId: 'acct_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'auth-rec-1', recordName: 'x', manual: false }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { provisionDomain } from '../../src/dns/provision';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

const ZONES = {
  'acme.com': { id: 'zone-acme', accountId: 'cf-acct' },
  'other-company.org': { id: 'zone-other', accountId: 'cf-acct' },
};

/** acme.com is the base domain (its zone is stored); other-company.org lives in a second zone. */
function makeEnv(domains: { id: number; domain: string; dns_record_id?: string }[], token: string | null = 'cf-token'): Env {
  const db = createMigratedD1();
  for (const d of domains) {
    db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id) VALUES (?, ?, ?, ?)')
      .run(d.id, d.domain, 'rua@reports.acme.com', d.dns_record_id ?? null);
  }
  seedSettings(db, {
    base_domain: 'acme.com', reports_domain: 'reports.acme.com', from_email: 'noreply@reports.acme.com',
    zone_id: 'zone-acme', zone_name: 'acme.com', account_id: 'cf-acct',
  });
  return { DB: db as unknown as D1Database, API_KEY: 'k', CLOUDFLARE_API_TOKEN: token ?? undefined } as Env;
}

function applyDmarc(id: number, record = 'v=DMARC1; p=none; rua=mailto:rua@reports.acme.com'): Request {
  return new Request(`https://x.test/api/domains/${id}/apply-dmarc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ record }),
  });
}

let cf: FakeCloudflare;
beforeEach(() => {
  cf = stubCloudflare(new FakeCloudflare(ZONES));
  vi.mocked(provisionDomain).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/domains/:id/apply-dmarc', () => {
  it('creates _dmarc.{domain} TXT when none exists', async () => {
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true });

    const [post] = cf.forZone('zone-acme').filter(c => c.method === 'POST');
    expect(post.url).toBe('https://api.cloudflare.com/client/v4/zones/zone-acme/dns_records');
    expect(post.body).toMatchObject({ type: 'TXT', name: '_dmarc.acme.com', ttl: 3600 });
    expect(post.auth).toBe('Bearer cf-token');
  });

  it('PATCHes the existing record in place', async () => {
    const existing = cf.seed('zone-acme', { type: 'TXT', name: '_dmarc.acme.com', content: 'v=DMARC1; p=reject' });
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(await res.json()).toMatchObject({ ok: true, created: false });
    const patch = cf.calls.find(c => c.method === 'PATCH')!;
    expect(patch.url).toBe(`https://api.cloudflare.com/client/v4/zones/zone-acme/dns_records/${existing.id}`);
  });

  it('surfaces a Cloudflare rejection as 500 with the CF message', async () => {
    cf.failZone = { zoneId: 'zone-acme', status: 400, message: 'CF says no' };
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'CF says no' });
  });

  it('400s without Cloudflare credentials, 404s for unknown domains, 400s without a record', async () => {
    expect((await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }], null), ctx)).status).toBe(400);
    expect((await handleApi(applyDmarc(9), makeEnv([]), ctx)).status).toBe(404);
    const noRecord = new Request('https://x.test/api/domains/1/apply-dmarc', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: '{}',
    });
    expect((await handleApi(noRecord, makeEnv([{ id: 1, domain: 'acme.com' }]), ctx)).status).toBe(400);
    expect(cf.calls).toHaveLength(0);
  });

  it('provisions the cross-domain auth record once, and skips it when one is already stored', async () => {
    const res = await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com' }]), ctx);
    expect(await res.json()).toMatchObject({ auth_record_provisioned: true });
    expect(provisionDomain).toHaveBeenCalledTimes(1);

    await handleApi(applyDmarc(1), makeEnv([{ id: 1, domain: 'acme.com', dns_record_id: 'have-one' }]), ctx);
    expect(provisionDomain).toHaveBeenCalledTimes(1);
  });
});

describe('apply-dmarc zone targeting (two domains, two zones)', () => {
  it('writes each domain into its own zone, never the default one', async () => {
    const env = makeEnv([{ id: 1, domain: 'acme.com' }, { id: 2, domain: 'other-company.org' }]);

    expect((await handleApi(applyDmarc(1, 'v=DMARC1; p=none'), env, ctx)).status).toBe(200);
    expect((await handleApi(applyDmarc(2, 'v=DMARC1; p=reject'), env, ctx)).status).toBe(200);

    expect(cf.records.get('zone-acme')).toEqual([expect.objectContaining({ name: '_dmarc.acme.com', content: 'v=DMARC1; p=none' })]);
    expect(cf.records.get('zone-other')).toEqual([expect.objectContaining({ name: '_dmarc.other-company.org', content: 'v=DMARC1; p=reject' })]);
  });

  it('resolves a subdomain to the zone of its registrable domain', async () => {
    const env = makeEnv([{ id: 3, domain: 'mail.other-company.org' }]);
    await handleApi(applyDmarc(3), env, ctx);
    expect(cf.records.get('zone-other')).toEqual([expect.objectContaining({ name: '_dmarc.mail.other-company.org' })]);
    expect(cf.records.get('zone-acme')).toBeUndefined();
  });

  it('looks a zone up once per request, however many calls need it', async () => {
    const env = makeEnv([{ id: 2, domain: 'other-company.org' }]);
    await handleApi(applyDmarc(2), env, ctx);
    const lookups = cf.calls.filter(c => c.url.includes('/zones?name=other-company.org'));
    expect(lookups).toHaveLength(1);
  });

  it('refuses to write when the domain has no zone on the account (400, nothing written)', async () => {
    const env = makeEnv([{ id: 4, domain: 'unmanaged.net' }]);
    const res = await handleApi(applyDmarc(4), env, ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/No Cloudflare zone found for unmanaged\.net/);
    expect(cf.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    expect([...cf.records.values()].flat()).toHaveLength(0);
  });

  it('surfaces a 403 on the domain\'s zone instead of writing elsewhere', async () => {
    cf.failZone = { zoneId: 'zone-other', status: 403, message: 'forbidden' };
    const env = makeEnv([{ id: 2, domain: 'other-company.org' }]);
    const res = await handleApi(applyDmarc(2), env, ctx);
    expect(res.status).toBe(500);
    expect(cf.forZone('zone-acme')).toHaveLength(0);
  });
});

describe('apply-dmarc with nested zones', () => {
  it('writes to the child zone even though the parent zone is the stored base zone', async () => {
    cf.zones['sub.acme.com'] = { id: 'zone-sub', accountId: 'cf-acct' };
    const env = makeEnv([{ id: 5, domain: 'sub.acme.com' }, { id: 6, domain: 'www.acme.com' }]);
    await handleApi(applyDmarc(5), env, ctx);
    await handleApi(applyDmarc(6), env, ctx);
    expect(cf.records.get('zone-sub')).toEqual([expect.objectContaining({ name: '_dmarc.sub.acme.com' })]);
    expect(cf.records.get('zone-acme')).toEqual([expect.objectContaining({ name: '_dmarc.www.acme.com' })]);
  });
});
