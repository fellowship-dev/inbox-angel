// Router routes that read live DNS must report DNS *errors* as errors, never as "record not found".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';
import type { Domain } from '../../src/db/types';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'org_test', accountId: 'acct_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn(),
  deprovisionDomain: vi.fn(),
  DnsProvisionError: class DnsProvisionError extends Error {},
}));
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { handleApi } from '../../src/api/router';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const DOMAIN: Partial<Domain> = { id: 1, domain: 'acme.com', rua_address: 'rua@reports.test.com', dns_record_id: null };

function makeEnv(): Env {
  const db = createMigratedD1();
  db.sqlite.prepare('INSERT INTO domains (id, domain, rua_address, dns_record_id) VALUES (?, ?, ?, ?)').run(DOMAIN.id!, DOMAIN.domain!, DOMAIN.rua_address!, null);
  seedSettings(db, { reports_domain: 'reports.test.com', from_email: 'noreply@reports.test.com' });
  return { DB: db as unknown as D1Database, API_KEY: 'k' } as unknown as Env;
}

const get = (path: string) => new Request(`https://api.inboxangel.com${path}`, { method: 'GET' });
const doh = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 503 });

type Rule = (name: string, type: string) => Response | Error | undefined;
function stubDns(rule: Rule) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url.toString());
    const r = rule(u.searchParams.get('name') ?? '', u.searchParams.get('type') ?? '');
    if (r instanceof Error) throw r;
    return r ?? doh({ Status: 3 });
  }));
}
const txt = (...v: string[]) => doh({ Status: 0, Answer: v.map(data => ({ type: 16, data: `"${data}"` })) });

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/domains/:id/dns-check', () => {
  it('found: returns the record and has_rua', async () => {
    stubDns(n => (n === '_dmarc.acme.com' ? txt('v=DMARC1; p=none; rua=mailto:rua@reports.test.com') : undefined));
    const res = await handleApi(get('/api/domains/1/dns-check'), makeEnv(), ctx);
    expect(await res.json()).toMatchObject({ found: true, has_rua: true, current_record: 'v=DMARC1; p=none; rua=mailto:rua@reports.test.com' });
  });
  it('NXDOMAIN: found=false and no error flag', async () => {
    stubDns(() => undefined);
    const body = await (await handleApi(get('/api/domains/1/dns-check'), makeEnv(), ctx)).json() as any;
    expect(body.found).toBe(false);
    expect(body.error).toBeUndefined();
  });
  it.each([
    ['SERVFAIL', () => doh({ Status: 2 })],
    ['DoH HTTP error', () => doh({}, false)],
    ['timeout', () => new Error('timeout')],
    ['malformed answer', () => doh({ Status: 0, Answer: 'x' })],
  ])('%s: reported as an error, not "not found"', async (_n, mk) => {
    stubDns(() => mk());
    const body = await (await handleApi(get('/api/domains/1/dns-check'), makeEnv(), ctx)).json() as any;
    expect(body.found).toBe(false);
    expect(body.error).toBe('dns lookup failed');
  });
});

describe('GET /api/domains/:id/onboarding-status', () => {
  it('surfaces failed lookups in dns_errors and flags the dmarc error', async () => {
    stubDns((n, t) => (t === 'TXT' && n.startsWith('_dmarc.acme.com') ? doh({ Status: 2 }) : t === 'TXT' && n === 'acme.com' ? txt('v=spf1 -all') : undefined));
    const res = await handleApi(get('/api/domains/1/onboarding-status'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spf.record).toBe('v=spf1 -all');
    expect(body.dmarc.found).toBe(false);
    expect(body.dmarc.error).toMatch(/SERVFAIL/);
    expect(body.dns_errors.some((e: string) => e.startsWith('dmarc:'))).toBe(true);
  });
  it('no dns_errors when everything resolves or is authoritatively absent', async () => {
    stubDns(() => undefined);
    const body = await (await handleApi(get('/api/domains/1/onboarding-status'), makeEnv(), ctx)).json() as any;
    expect(body.dns_errors).toBeUndefined();
    expect(body.dmarc.found).toBe(false);
    expect(body.dmarc.error).toBeUndefined();
  });
});
