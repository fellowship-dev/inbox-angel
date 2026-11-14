import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }));

import { createMigratedD1 } from '@ready-set-mail/db/testing';
import type { BoundEnv } from '../../src/index';
import { runCronForWorkspaces } from '../../src/cron';
import { loadTenant } from '../../src/tenancy/load';
import { listCronWorkspaces } from '../../src/tenancy/resolver';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const SPF_CRON = { cron: '0 10 * * *' } as ScheduledController;

const WORKSPACES = [
  { id: 'ws_a', domain: 'a-corp.com', zone: 'zone-a', token: 'tok-a', domainId: 1 },
  { id: 'ws_b', domain: 'b-corp.org', zone: 'zone-b', token: 'tok-b', domainId: 2 },
  { id: 'ws_c', domain: 'c-corp.net', zone: 'zone-c', token: 'tok-c', domainId: 3 },
];

/** Three workspaces, each with one domain in its own zone and SPF flattening enabled. */
function setup() {
  const db = createMigratedD1();
  const cf = new FakeCloudflare({}, undefined, undefined, {});
  for (const a of WORKSPACES) {
    db.sqlite.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(a.id, a.id);
    seedSettings(db, {
      base_domain: a.domain, reports_domain: `reports.${a.domain}`, zone_id: a.zone, zone_name: a.domain, cf_account_id: `cf-${a.id}`,
    }, a.id);
    db.sqlite.prepare('INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, ?, ?, ?)').run(a.domainId, a.id, a.domain, `rua@reports.${a.domain}`);
    db.sqlite.prepare('INSERT INTO spf_flatten_config (domain_id, workspace_id, enabled, canonical_record, cf_record_id) VALUES (?, ?, 1, ?, ?)')
      .run(a.domainId, a.id, 'v=spf1 include:_spf.mail.test -all', `spf-${a.id}`);
    cf.zones[a.domain] = { id: a.zone, cfAccountId: `cf-${a.id}` };
    cf.seed(a.zone, { id: `spf-${a.id}`, type: 'TXT', name: a.domain, content: 'v=spf1 include:_spf.mail.test -all' });
  }
  cf.doh['_spf.mail.test'] = ['v=spf1 ip4:192.0.2.1 -all'];
  for (const a of WORKSPACES) cf.doh[a.domain] = ['v=spf1 include:_spf.mail.test -all'];
  stubCloudflare(cf);

  const env = { DB: db as unknown as D1Database, CLOUDFLARE_API_TOKEN: 'unused-default' } as unknown as BoundEnv;
  const load = (e: BoundEnv, workspace: { workspaceId: string }) =>
    loadTenant(e, workspace, { cfToken: WORKSPACES.find(a => a.id === workspace.workspaceId)!.token });
  const state = (id: string) => db.sqlite.prepare('SELECT flattened_record, last_error FROM spf_flatten_config WHERE workspace_id = ?').get(id) as any;
  return { db, cf, env, load, state };
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cron iterates workspaces, each in its own try', () => {
  it('flattens every workspace\'s SPF record in that workspace\'s own zone', async () => {
    const { cf, env, load, state } = setup();
    await runCronForWorkspaces(SPF_CRON, env, ctx, { workspaces: WORKSPACES.map(a => a.id), load });

    for (const a of WORKSPACES) {
      expect(state(a.id).last_error).toBeNull();
      expect(cf.records.get(a.zone)).toEqual([expect.objectContaining({ content: 'v=spf1 ip4:192.0.2.1 -all' })]);
    }
    // each workspace used its own token
    for (const a of WORKSPACES) {
      expect(cf.forZone(a.zone).every(c => c.auth === `Bearer ${a.token}`)).toBe(true);
    }
  });

  it('one workspace\'s Cloudflare 403 does not stop the workspaces after it', async () => {
    const { cf, env, load, state } = setup();
    cf.failZone = { zoneId: 'zone-a', status: 403, message: 'Authentication error' };

    await runCronForWorkspaces(SPF_CRON, env, ctx, { workspaces: ['ws_a', 'ws_b', 'ws_c'], load });

    expect(state('ws_a').last_error).toMatch(/Authentication error/);
    expect(state('ws_a').flattened_record).toBeNull();
    expect(state('ws_b').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
    expect(state('ws_c').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
    expect(cf.records.get('zone-a')).toEqual([expect.objectContaining({ content: 'v=spf1 include:_spf.mail.test -all' })]);
  });

  it('a workspace that fails to load is logged and skipped, the rest still run', async () => {
    const { env, load, state } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky = (e: BoundEnv, workspace: { workspaceId: string }) => {
      if (workspace.workspaceId === 'ws_a') throw new Error('settings table unreadable');
      return load(e, workspace);
    };

    await runCronForWorkspaces(SPF_CRON, env, ctx, { workspaces: ['ws_a', 'ws_b', 'ws_c'], load: flaky });

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('workspace ws_a failed'), expect.stringContaining('settings table unreadable'));
    expect(state('ws_b').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
    expect(state('ws_c').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
  });

  it('does not log any workspace\'s token', async () => {
    const { cf, env, load } = setup();
    cf.failZone = { zoneId: 'zone-a', status: 403, message: 'Authentication error' };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await runCronForWorkspaces(SPF_CRON, env, ctx, { workspaces: ['ws_a', 'ws_b', 'ws_c'], load });
    const logged = spies.flatMap(s => s.mock.calls.map(c => c.map(String).join(' '))).join('\n');
    for (const a of WORKSPACES) expect(logged).not.toContain(a.token);
  });
});

describe('SPF lookup-count refresh in the default cron', () => {
  const DAILY = { cron: '0 8 * * *' } as ScheduledController;

  it('is finished (awaited) when the cron returns, with bounded concurrency', async () => {
    const { db, cf, env, load } = setup();
    for (let i = 10; i < 22; i++) {
      db.sqlite.prepare('INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, ?, ?, ?)').run(i, 'ws_a', `d${i}.a-corp.com`, 'r@x');
      cf.doh[`d${i}.a-corp.com`] = ['v=spf1 ip4:192.0.2.9 -all'];
    }
    let inFlight = 0, peak = 0;
    const base = cf.fetch.getMockImplementation()!;
    cf.fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input)).hostname === 'cloudflare-dns.com') {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
      }
      return base(input, init);
    });

    await runCronForWorkspaces(DAILY, env, ctx, { workspaces: ['ws_a'], load });

    expect(inFlight).toBe(0); // nothing still running after the cron resolved
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    const counted = db.sqlite.prepare("SELECT COUNT(*) AS n FROM domains WHERE workspace_id = 'ws_a' AND spf_lookup_count IS NOT NULL").get() as any;
    expect(counted.n).toBe(13); // all 12 added + a-corp.com
  });

  it('mapLimit never runs more than the limit at once', async () => {
    const { mapLimit } = await import('../../src/cron');
    let n = 0, peak = 0;
    await mapLimit([...Array(20).keys()], 3, async () => { n++; peak = Math.max(peak, n); await new Promise(r => setTimeout(r, 1)); n--; });
    expect(peak).toBe(3);
  });
});

describe('listCronWorkspaces', () => {
  it('self-host covers exactly the implicit workspace, without touching the database', async () => {
    expect(await listCronWorkspaces({ DB: undefined } as any)).toEqual(['ws_default']);
    expect(await listCronWorkspaces({ DB: undefined, MODE: 'selfhost' } as any)).toEqual(['ws_default']);
  });

  it('saas covers every workspace in the workspaces table', async () => {
    const { env } = setup();
    expect(await listCronWorkspaces({ ...env, MODE: 'saas' } as any)).toEqual(['ws_default', 'ws_a', 'ws_b', 'ws_c']);
  });
});

describe('daily cron stores what DNS says: SPF, the effective DMARC policy, and how the check went', () => {
  const DAILY = { cron: '0 8 * * *' } as ScheduledController;
  const COLS = 'spf_record, dmarc_policy, dmarc_issue, dmarc_inherited_from, dns_checked_at, dns_check_attempted_at, dns_check_status, spf_lookup_count';
  const row = (db: any, id: number) => db.sqlite.prepare(`SELECT ${COLS} FROM domains WHERE id = ?`).get(id) as any;
  const NOW = 1_700_000_000;
  /** Answer one DoH name with a raw response instead of the fake's table (SERVFAIL, NOERROR-empty, ...). */
  const override = (cf: FakeCloudflare, name: string, respond: () => Response) => {
    const base = cf.fetch.getMockImplementation()!;
    cf.fetch.mockImplementation(async (input, init) => {
      const u = new URL(String(input));
      return u.hostname === 'cloudflare-dns.com' && u.searchParams.get('name') === name ? respond() : base(input, init);
    });
  };
  const servfail = () => new Response(JSON.stringify({ Status: 2 }), { status: 200 });
  const http503 = () => new Response('', { status: 503 });
  /** A subdomain of a-corp.com in the same workspace, with SPF of its own. */
  const addSub = (db: any, cf: FakeCloudflare) => {
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (4, 'ws_a', 'mail.a-corp.com', 'rua@reports.a-corp.com')").run();
    cf.doh['mail.a-corp.com'] = ['v=spf1 include:_spf.mail.test -all'];
  };
  const runA = (env: BoundEnv, load: any) => runCronForWorkspaces(DAILY, env, ctx, { workspaces: ['ws_a'], load });

  it('writes what DNS answered: an own record is stored as its p=, "no record" as null', async () => {
    const { db, cf, env, load } = setup();
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; sp=reject; p=quarantine; rua=mailto:x@y.z'];
    // b-corp.org: SPF present, no DMARC record anywhere. c-corp.net: nothing published at all (does not exist).
    delete cf.doh['c-corp.net'];
    await runCronForWorkspaces(DAILY, env, ctx, { workspaces: ['ws_a', 'ws_b', 'ws_c'], load });

    expect(row(db, 1)).toMatchObject({ spf_record: 'v=spf1 include:_spf.mail.test -all', dmarc_policy: 'quarantine', dmarc_issue: null, dmarc_inherited_from: null, dns_check_status: 'ok', spf_lookup_count: 1 });
    expect(row(db, 1).dns_checked_at).toBeGreaterThan(NOW);
    expect(row(db, 1).dns_check_attempted_at).toBe(row(db, 1).dns_checked_at);
    expect(row(db, 2)).toMatchObject({ spf_record: 'v=spf1 include:_spf.mail.test -all', dmarc_policy: null, dmarc_issue: null, dns_check_status: 'ok' });
    expect(row(db, 2).dns_checked_at).toBeGreaterThan(NOW);
    expect(row(db, 3)).toMatchObject({ spf_record: null, dmarc_policy: null });
  });

  it('a subdomain with no DMARC record of its own gets the parent\'s sp= (RFC 7489), and says it is inherited', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none; sp=reject'];
    await runA(env, load);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: 'reject', dmarc_inherited_from: 'a-corp.com', dmarc_issue: null, dns_check_status: 'ok' });
    expect(row(db, 1)).toMatchObject({ dmarc_policy: 'none', dmarc_inherited_from: null }); // the parent itself uses p=
  });

  it('inherits the parent\'s p= when it has no sp=', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=quarantine'];
    await runA(env, load);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: 'quarantine', dmarc_inherited_from: 'a-corp.com' });
  });

  it('a subdomain\'s own record wins over the parent\'s sp=', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject; sp=reject'];
    cf.doh['_dmarc.mail.a-corp.com'] = ['v=DMARC1; p=none'];
    await runA(env, load);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: 'none', dmarc_inherited_from: null });
  });

  it('no DMARC at the subdomain or its parent: null, and the check counts as done', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    await runA(env, load);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: null, dmarc_issue: null, dmarc_inherited_from: null, dns_check_status: 'ok' });
    expect(row(db, 4).dns_checked_at).toBeGreaterThan(NOW);
  });

  it('the parent lookup failing stores nothing for DMARC: the old policy stays and the check time does not advance', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    db.sqlite.prepare("UPDATE domains SET dmarc_policy = 'reject', dmarc_inherited_from = 'a-corp.com', dns_checked_at = 5 WHERE id = 4").run();
    override(cf, '_dmarc.a-corp.com', servfail);
    await runA(env, load);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: 'reject', dmarc_inherited_from: 'a-corp.com', dns_checked_at: 5, dns_check_status: 'failed' });
    expect(row(db, 4).dns_check_attempted_at).toBeGreaterThan(NOW);
  });

  it('several DMARC records, or an invalid one: no policy is invented, and the check is recorded', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    db.sqlite.prepare("UPDATE domains SET dmarc_policy = 'reject' WHERE id IN (1, 4)").run();
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none', 'v=DMARC1; p=reject'];
    cf.doh['_dmarc.mail.a-corp.com'] = ['v=DMARC1; p=banana'];
    await runA(env, load);
    expect(row(db, 1)).toMatchObject({ dmarc_policy: null, dmarc_issue: 'multiple', dmarc_inherited_from: null, dns_check_status: 'ok' });
    expect(row(db, 1).dns_checked_at).toBeGreaterThan(NOW);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: null, dmarc_issue: 'invalid', dns_check_status: 'ok' });
  });

  it('a parent with several records covers the subdomain with nothing, and says whose records they are', async () => {
    const { db, cf, env, load } = setup();
    addSub(db, cf);
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none', 'v=DMARC1; p=reject'];
    await runA(env, load);
    expect(row(db, 4)).toMatchObject({ dmarc_policy: null, dmarc_issue: 'multiple', dmarc_inherited_from: 'a-corp.com' });
  });

  it('a failed DMARC lookup keeps the stored policy and the old check time, and records the failed attempt', async () => {
    const { db, cf, env, load } = setup();
    db.sqlite.prepare("UPDATE domains SET spf_record = 'v=spf1 -all', dmarc_policy = 'reject', dns_checked_at = 5 WHERE id = 1").run();
    override(cf, '_dmarc.a-corp.com', servfail);
    await runA(env, load);
    expect(row(db, 1)).toMatchObject({ spf_record: 'v=spf1 include:_spf.mail.test -all', dmarc_policy: 'reject', dns_checked_at: 5, dns_check_status: 'failed' });
    expect(row(db, 1).dns_check_attempted_at).toBeGreaterThan(NOW);
  });

  it('a failed SPF lookup is unknown, not "no SPF": the stored record survives and the attempt is recorded as failed', async () => {
    const { db, cf, env, load } = setup();
    db.sqlite.prepare("UPDATE domains SET spf_record = 'v=spf1 -all', dmarc_policy = 'reject', dns_checked_at = 5 WHERE id = 1").run();
    cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none'];
    override(cf, 'a-corp.com', http503);
    await runA(env, load);
    expect(row(db, 1)).toMatchObject({ spf_record: 'v=spf1 -all', dmarc_policy: 'none', dns_checked_at: 5, dns_check_status: 'failed' });
  });

  it('a domain that does not exist (NXDOMAIN) is recorded as such, not as a delivering domain with no records', async () => {
    const { db, env, load, cf } = setup();
    delete cf.doh['a-corp.com'];
    await runA(env, load);
    expect(row(db, 1)).toMatchObject({ spf_record: null, dmarc_policy: null, dns_check_status: 'nxdomain' });
    expect(row(db, 1).dns_checked_at).toBeGreaterThan(NOW);
  });

  it('NOERROR with no TXT (the name exists, nothing published) is not NXDOMAIN', async () => {
    const { db, env, load, cf } = setup();
    override(cf, 'a-corp.com', () => new Response(JSON.stringify({ Status: 0 }), { status: 200 }));
    await runA(env, load);
    expect(row(db, 1)).toMatchObject({ spf_record: null, dns_check_status: 'ok' });
  });

  it('visits never-checked domains first, then the longest since a successful check', async () => {
    const { db, cf, env, load } = setup();
    for (const [id, name, at] of [[4, 'old.a-corp.com', 100], [5, 'recent.a-corp.com', 900], [6, 'never.a-corp.com', null]] as const) {
      db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, dns_checked_at) VALUES (?, 'ws_a', ?, 'r@x', ?)").run(id, name, at);
    }
    db.sqlite.prepare('UPDATE domains SET dns_checked_at = 500 WHERE id = 1').run();
    await runA(env, load);
    const firstAsks = cf.fetch.mock.calls
      .map(([u]) => new URL(String(u)))
      .filter(u => u.hostname === 'cloudflare-dns.com' && u.searchParams.get('type') === 'TXT' && !u.searchParams.get('name')!.startsWith('_'))
      .map(u => u.searchParams.get('name'));
    expect(firstAsks.slice(0, 4)).toEqual(['never.a-corp.com', 'old.a-corp.com', 'a-corp.com', 'recent.a-corp.com']);
  });
});
