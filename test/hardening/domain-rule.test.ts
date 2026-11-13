// Item 5: one domain rule on every server path (the same one the dashboard's input uses).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { seedSettings } from '../helpers/tenant';
import { makeTenant } from '../helpers/tenant';
import { enrollDomain, DomainServiceError } from '../../src/domains/service';
import { bulkInsertDomains, validateDomain } from '../../src/domains/bulk';
import { json, nxdomain } from './helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: null, manual: true }),
}));
beforeEach(nxdomain);
afterEach(() => vi.unstubAllGlobals());

const INVALID = ['-a.com', 'a..b.com', '.example.com', `${'a'.repeat(64)}.com`, 'a-.com', '1.2.3.4', 'a_b.example.com'];
const SPECIAL = ['printer.local', 'nas.internal', 'abc.onion', 'site.test', 'x.invalid', 'printer.example', 'app.localhost', 'router.home.arpa', 'localhost'];
const GOOD = ['example.com', 'xn--mnchen-3ya.de', 'a-b.co.uk', 'example.org'];
const SPECIAL_MESSAGE = (n: string) => `${n} is a special-use name and can't be monitored on the public internet.`;

async function world() {
  const db = createMigratedD1();
  seedSettings(db, { reports_domain: 'reports.test.com', from_email: 'noreply@reports.test.com' });
  const env = makeEnv(db);
  const owner = await setupOwner(env);
  const post = (path: string, body: unknown) => call(env, 'POST', path, { key: owner, body });
  return { db, env, owner, post, get: (path: string) => call(env, 'GET', path, { key: owner }) };
}

describe('POST /api/domains', () => {
  it.each(INVALID)('refuses %s as invalid domain format', async (d) => {
    const w = await world();
    const res = await w.post('/api/domains', { domain: d });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid domain format' });
  });
  it.each(SPECIAL)('refuses %s as special-use, with its code', async (d) => {
    const w = await world();
    const res = await w.post('/api/domains', { domain: d });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: SPECIAL_MESSAGE(d), code: 'special_use_domain' });
  });
  it.each(GOOD)('still takes %s', async (d) => {
    const w = await world();
    const res = await w.post('/api/domains', { domain: d });
    expect(res.status).toBe(201);
    expect(w.db.sqlite.prepare('SELECT domain FROM domains').all()).toEqual([{ domain: d }]);
  });
  it('stores the normalised name for a messy but valid one', async () => {
    const w = await world();
    expect((await w.post('/api/domains', { domain: '  München.DE. ' })).status).toBe(201);
    expect(w.db.sqlite.prepare('SELECT domain FROM domains').all()).toEqual([{ domain: 'xn--mnchen-3ya.de' }]);
  });
});

describe('POST /api/settings/base-domain', () => {
  it.each(INVALID)('refuses %s as invalid domain format', async (d) => {
    const w = await world();
    const res = await w.post('/api/settings/base-domain', { domain: d });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid domain format' });
  });
  it.each(SPECIAL)('refuses %s as special-use', async (d) => {
    const w = await world();
    const res = await w.post('/api/settings/base-domain', { domain: d });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: SPECIAL_MESSAGE(d), code: 'special_use_domain' });
  });
  it.each(GOOD)('still takes %s', async (d) => {
    const w = await world();
    const res = await w.post('/api/settings/base-domain', { domain: d });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });
});

describe('GET /api/domains/ct-discover', () => {
  it.each([...INVALID, 'printer.local'])('refuses %s before any lookup', async (d) => {
    const w = await world();
    const res = await w.get(`/api/domains/ct-discover?domain=${encodeURIComponent(d)}`);
    expect(res.status).toBe(400);
  });
});

describe('bulk import', () => {
  it('marks invalid and special-use rows with the same messages, and imports the good ones', async () => {
    const w = await world();
    const rows = [...INVALID, ...SPECIAL, ...GOOD];
    const res = await w.post('/api/domains/bulk-import', { domains: rows.join('\n').slice(0) });
    const body = await json(res);
    const by = Object.fromEntries(body.results.map((r: any) => [r.domain, r]));
    for (const d of INVALID) expect(by[d], d).toMatchObject({ status: 'invalid', error: 'invalid domain format' });
    for (const d of SPECIAL) expect(by[d], d).toMatchObject({ status: 'invalid', error: SPECIAL_MESSAGE(d) });
    for (const d of GOOD) expect(by[d], d).toMatchObject({ status: 'imported' });
  });
  it('validateDomain agrees with the shared rule', () => {
    for (const d of [...INVALID, ...SPECIAL]) expect(validateDomain(d), d).toBe(false);
    for (const d of GOOD) expect(validateDomain(d), d).toBe(true);
  });
  it('bulkInsertDomains directly', async () => {
    const tenant = makeTenant({});
    const results = await bulkInsertDomains(tenant, ['-a.com', 'printer.local', 'example.com']);
    expect(results.map(r => r.status)).toEqual(['invalid', 'invalid', 'imported']);
  });
});

describe('enrollDomain (REST, and the MCP add_domain tool, which calls it)', () => {
  const enroll = (d: string) => enrollDomain(makeTenant({}), d);
  it.each(INVALID)('refuses %s', async (d) => {
    await expect(enroll(d)).rejects.toMatchObject({ message: 'invalid domain format', status: 400 });
  });
  it.each(SPECIAL)('refuses %s as special-use with its code', async (d) => {
    const e = await enroll(d).catch(x => x);
    expect(e).toBeInstanceOf(DomainServiceError);
    expect(e).toMatchObject({ message: SPECIAL_MESSAGE(d), status: 400, body: { error: SPECIAL_MESSAGE(d), code: 'special_use_domain' } });
  });
  it.each(GOOD)('still takes %s', async (d) => {
    expect(await enroll(d)).toMatchObject({ domain: { domain: d } });
  });
});
