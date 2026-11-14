// A claim that has become a domain stays as a settled row, so a repeat verify (a second tab, a retry after a lost response)
// finds the domain instead of a 404. Settled rows are invisible to every other reader and expire after a day.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hosted, json, nxdomain, provenDns } from './helpers';
import { runRetention } from '../../src/lifecycle/retention';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: null, manual: true }),
  deprovisionDomain: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(nxdomain);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function settled() {
  const w = await hosted();
  const a = await w.user('a@example.com');
  const b = await w.user('b@example.com');
  const add = async (domain: string, who = a) => (await json(await w.api(who, 'POST', '/api/domains', { domain }))).claim;
  const verify = (id: number, who = a) => w.api(who, 'POST', `/api/domains/claims/${id}/verify`, {});
  const claim = await add('acme.org');
  provenDns('_inboxangel.acme.org', claim.txt_value);
  const first = await verify(claim.id);
  const list = async (who = a) => (await json(await w.api(who, 'GET', '/api/domains'))) as { domains: any[]; pending_claims: any[] };
  return { ...w, a, b, add, verify, claim, first, list };
}

describe('a settled claim', () => {
  it('a sequential repeat verify answers 200 with the domain, no DNS needed', async () => {
    const w = await settled();
    expect(w.first.status).toBe(201);
    const id = (await json(w.first)).domain.id;
    nxdomain();
    const again = await w.verify(w.claim.id);
    expect(again.status).toBe(200);
    const body = await json(again);
    expect(body.resumed).toBe(true);
    expect(body.domain.id).toBe(id);
  });

  it('is kept as a row marked settled, linked to the domain, and gone from the claim list', async () => {
    const w = await settled();
    const id = (await json(w.first)).domain.id;
    expect(w.rows('SELECT settled_domain_id, settled_at FROM domain_claims WHERE id = ?', w.claim.id)).toMatchObject([{ settled_domain_id: id }]);
    expect((await w.list()).pending_claims).toEqual([]);
  });

  it('does not count toward the pending-claims limit', async () => {
    const w = await settled();
    for (let i = 0; i < 25; i++) expect((await w.add(`p${i}.example.org`)).status).toBe('pending');
    const over = await w.api(w.a, 'POST', '/api/domains', { domain: 'one-too-many.example.org' });
    expect(over.status).toBe(429);
  });

  it('is not previewed or deleted as a pending claim', async () => {
    const w = await settled();
    expect((await w.api(w.a, 'GET', `/api/domains/claims/${w.claim.id}/preview`)).status).toBe(404);
    expect((await w.api(w.a, 'DELETE', `/api/domains/claims/${w.claim.id}`)).status).toBe(404);
  });

  it('another workspace’s settled claim id is 404', async () => {
    const w = await settled();
    expect((await w.verify(w.claim.id, w.b)).status).toBe(404);
    expect(w.rows('SELECT id FROM domain_claims WHERE id = ?', w.claim.id)).toHaveLength(1);
  });

  it('after the domain is removed the settled id is 404, and add → remove → re-add works', async () => {
    const w = await settled();
    const id = (await json(w.first)).domain.id;
    expect((await w.api(w.a, 'DELETE', `/api/domains/${id}`)).status).toBe(204);
    expect((await w.verify(w.claim.id)).status).toBe(404);

    const claim2 = await w.add('acme.org');
    expect(claim2.status).toBe('pending');
    expect((await w.list()).pending_claims.map((c: any) => c.domain)).toEqual(['acme.org']);
    expect(w.rows("SELECT id FROM domain_claims WHERE domain = 'acme.org'")).toHaveLength(1);
    provenDns('_inboxangel.acme.org', claim2.txt_value);
    const again = await w.verify(claim2.id);
    expect(again.status).toBe(201);
    expect((await w.verify(claim2.id)).status).toBe(200);
  });

  it('another workspace verifying the same name later still marks only pending claims lost', async () => {
    const w = await settled();
    const id = (await json(w.first)).domain.id;
    await w.api(w.a, 'DELETE', `/api/domains/${id}`);
    const bClaim = await w.add('acme.org', w.b);
    provenDns('_inboxangel.acme.org', bClaim.txt_value);
    expect((await w.verify(bClaim.id, w.b)).status).toBe(201);
    expect(w.rows('SELECT status FROM domain_claims WHERE id = ?', w.claim.id)).toEqual([{ status: 'pending' }]); // A's settled row is not rewritten
  });
});

describe('the retention job and settled claims', () => {
  it('deletes settled claims older than a day, keeps newer ones and every pending claim', async () => {
    const w = await settled();
    const now = Math.floor(Date.now() / 1000);
    const ins = w.db.sqlite.prepare("INSERT INTO domain_claims (workspace_id, domain, token, settled_at, settled_domain_id) VALUES (?, ?, 't', ?, 1)");
    ins.run(w.a.ws, 'old.example.org', now - 2 * 86400);
    ins.run(w.a.ws, 'fresh.example.org', now - 3600);
    w.db.sqlite.prepare("INSERT INTO domain_claims (workspace_id, domain, token, created_at) VALUES (?, 'pending-old.example.org', 't', ?)").run(w.a.ws, now - 30 * 86400);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runRetention({ DB: w.db as any });
    expect(report.settled_claims).toBe(1);
    expect(w.rows('SELECT domain FROM domain_claims ORDER BY domain').map(r => r.domain)).toEqual(['acme.org', 'fresh.example.org', 'pending-old.example.org']);
  });
});
