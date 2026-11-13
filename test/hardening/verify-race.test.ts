// Item 6: two verifies of one claim at the cap. The loser says the domain is already added; it is never a plan limit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hosted, json, nxdomain, fillDomains, provenDns } from './helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: null, manual: true }),
}));
beforeEach(nxdomain);
afterEach(() => vi.unstubAllGlobals());

async function atCapMinusOne() {
  const w = await hosted({ MAX_DOMAINS_PER_WORKSPACE: '3' });
  const a = await w.user('a@example.com');
  fillDomains(w.db, a.ws, 2);
  const { claim } = await json(await w.api(a, 'POST', '/api/domains', { domain: 'acme.org' }));
  provenDns('_readysetmail.acme.org', claim.txt_value);
  const verify = () => w.api(a, 'POST', `/api/domains/claims/${claim.id}/verify`, {});
  const liveRows = () => w.rows("SELECT id FROM domains WHERE domain = 'acme.org' AND evicted_at IS NULL");
  return { ...w, a, claim, verify, liveRows };
}

/**
 * D1 lets two requests both read the claim before either settles it; node:sqlite is too fast to interleave them by chance. Hold the
 * first `n` reads of domain_claims until all `n` have arrived, so every request has loaded the claim when the first one commits.
 */
function bothLoadTheClaimFirst(db: any, n: number) {
  const waiting: Array<() => void> = [];
  let arrived = 0;
  const gate = async () => {
    if (arrived >= n) return;
    arrived++;
    if (arrived === n) waiting.splice(0).forEach(release => release());
    else await new Promise<void>(resolve => waiting.push(resolve));
  };
  const prepare = db.prepare.bind(db);
  const wrap = (st: any): any => new Proxy(st, {
    get: (t, k) => k === 'bind' ? (...a: unknown[]) => wrap(t.bind(...a)) : ['all', 'first', 'raw'].includes(k as string) ? async (...a: unknown[]) => { await gate(); return t[k](...a); } : t[k],
  });
  db.prepare = (sql: string) => /from "domain_claims"/i.test(sql) ? wrap(prepare(sql)) : prepare(sql);
}

describe('two simultaneous verifies of the same claim at cap minus one', () => {
  it('one answers 201, the other 200 with the same domain id; neither is 403; one domain row', async () => {
    const w = await atCapMinusOne();
    bothLoadTheClaimFirst(w.db, 2);
    const [r1, r2] = await Promise.all([w.verify(), w.verify()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const [b1, b2] = [await json(r1), await json(r2)];
    expect(b1.domain.id).toBe(b2.domain.id);
    expect([b1, b2].filter(b => b.resumed)).toHaveLength(1);
    expect(w.liveRows()).toHaveLength(1);
    expect(w.rows('SELECT COUNT(*) AS n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', w.a.ws)[0].n).toBe(3);
  });

  it('three at once: one 201, the rest 200, no 403, one row', async () => {
    const w = await atCapMinusOne();
    bothLoadTheClaimFirst(w.db, 3);
    const out = await Promise.all([w.verify(), w.verify(), w.verify()]);
    expect(out.map(r => r.status).sort()).toEqual([200, 200, 201]);
    expect(w.liveRows()).toHaveLength(1);
  });

  it('a claim whose domain is already live in this workspace resumes with 200 at the cap, before the cap check and without a DNS lookup', async () => {
    const w = await atCapMinusOne();
    expect((await w.verify()).status).toBe(201); // now 3 of 3
    // the claim row survives (a second tab created it again): the domain is ours already
    w.db.sqlite.prepare("INSERT INTO domain_claims (workspace_id, domain, token, status) VALUES (?, 'acme.org', 'again', 'pending')").run(w.a.ws);
    const again = w.rows("SELECT id FROM domain_claims WHERE domain = 'acme.org'")[0].id;
    nxdomain(); // no proof is published any more: the answer must not depend on it
    const res = await w.api(w.a, 'POST', `/api/domains/claims/${again}/verify`, {});
    expect(res.status).toBe(200);
    expect((await json(res)).resumed).toBe(true);
    expect(w.liveRows()).toHaveLength(1);
    expect(w.rows("SELECT id FROM domain_claims WHERE domain = 'acme.org'")).toEqual([]); // the leftover claim is gone
  });

  it('once the first verify has settled the claim, a late second verify is 404 claim not found: the id maps to no domain any more', async () => {
    const w = await atCapMinusOne();
    expect((await w.verify()).status).toBe(201);
    const late = await w.verify();
    expect(late.status).toBe(404);
    expect((await json(late)).error).toBe('claim not found');
    expect(w.liveRows()).toHaveLength(1);
  });

  it('a different domain at the cap is still a plan_limit', async () => {
    const w = await atCapMinusOne();
    expect((await w.verify()).status).toBe(201);
    const other = await json(await w.api(w.a, 'POST', '/api/domains', { domain: 'other.org' }));
    expect(other.code).toBe('plan_limit');
  });
});
