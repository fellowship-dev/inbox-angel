import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import type { BoundEnv } from '../../src/index';
import { runCronForAccounts } from '../../src/cron';
import { loadTenant } from '../../src/tenancy/load';
import { listCronAccounts } from '../../src/tenancy/resolver';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const SPF_CRON = { cron: '0 10 * * *' } as ScheduledController;

const ACCOUNTS = [
  { id: 'acct_a', domain: 'a-corp.com', zone: 'zone-a', token: 'tok-a', domainId: 1 },
  { id: 'acct_b', domain: 'b-corp.org', zone: 'zone-b', token: 'tok-b', domainId: 2 },
  { id: 'acct_c', domain: 'c-corp.net', zone: 'zone-c', token: 'tok-c', domainId: 3 },
];

/** Three accounts, each with one domain in its own zone and SPF flattening enabled. */
function setup() {
  const db = createMigratedD1();
  const cf = new FakeCloudflare({}, undefined, undefined, {});
  for (const a of ACCOUNTS) {
    db.sqlite.prepare('INSERT INTO accounts (id, name) VALUES (?, ?)').run(a.id, a.id);
    seedSettings(db, {
      base_domain: a.domain, reports_domain: `reports.${a.domain}`, zone_id: a.zone, zone_name: a.domain, account_id: `cf-${a.id}`,
    }, a.id);
    db.sqlite.prepare('INSERT INTO domains (id, account_id, domain, rua_address) VALUES (?, ?, ?, ?)').run(a.domainId, a.id, a.domain, `rua@reports.${a.domain}`);
    db.sqlite.prepare('INSERT INTO spf_flatten_config (domain_id, account_id, enabled, canonical_record, cf_record_id) VALUES (?, ?, 1, ?, ?)')
      .run(a.domainId, a.id, 'v=spf1 include:_spf.mail.test -all', `spf-${a.id}`);
    cf.zones[a.domain] = { id: a.zone, accountId: `cf-${a.id}` };
    cf.seed(a.zone, { id: `spf-${a.id}`, type: 'TXT', name: a.domain, content: 'v=spf1 include:_spf.mail.test -all' });
  }
  cf.doh['_spf.mail.test'] = ['v=spf1 ip4:192.0.2.1 -all'];
  for (const a of ACCOUNTS) cf.doh[a.domain] = ['v=spf1 include:_spf.mail.test -all'];
  stubCloudflare(cf);

  const env = { DB: db as unknown as D1Database, CLOUDFLARE_API_TOKEN: 'unused-default' } as unknown as BoundEnv;
  const load = (e: BoundEnv, account: { accountId: string }) =>
    loadTenant(e, account, { cfToken: ACCOUNTS.find(a => a.id === account.accountId)!.token });
  const state = (id: string) => db.sqlite.prepare('SELECT flattened_record, last_error FROM spf_flatten_config WHERE account_id = ?').get(id) as any;
  return { db, cf, env, load, state };
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cron iterates accounts, each in its own try', () => {
  it('flattens every account\'s SPF record in that account\'s own zone', async () => {
    const { cf, env, load, state } = setup();
    await runCronForAccounts(SPF_CRON, env, ctx, { accounts: ACCOUNTS.map(a => a.id), load });

    for (const a of ACCOUNTS) {
      expect(state(a.id).last_error).toBeNull();
      expect(cf.records.get(a.zone)).toEqual([expect.objectContaining({ content: 'v=spf1 ip4:192.0.2.1 -all' })]);
    }
    // each account used its own token
    for (const a of ACCOUNTS) {
      expect(cf.forZone(a.zone).every(c => c.auth === `Bearer ${a.token}`)).toBe(true);
    }
  });

  it('one account\'s Cloudflare 403 does not stop the accounts after it', async () => {
    const { cf, env, load, state } = setup();
    cf.failZone = { zoneId: 'zone-a', status: 403, message: 'Authentication error' };

    await runCronForAccounts(SPF_CRON, env, ctx, { accounts: ['acct_a', 'acct_b', 'acct_c'], load });

    expect(state('acct_a').last_error).toMatch(/Authentication error/);
    expect(state('acct_a').flattened_record).toBeNull();
    expect(state('acct_b').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
    expect(state('acct_c').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
    expect(cf.records.get('zone-a')).toEqual([expect.objectContaining({ content: 'v=spf1 include:_spf.mail.test -all' })]);
  });

  it('an account that fails to load is logged and skipped, the rest still run', async () => {
    const { env, load, state } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky = (e: BoundEnv, account: { accountId: string }) => {
      if (account.accountId === 'acct_a') throw new Error('settings table unreadable');
      return load(e, account);
    };

    await runCronForAccounts(SPF_CRON, env, ctx, { accounts: ['acct_a', 'acct_b', 'acct_c'], load: flaky });

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('account acct_a failed'), expect.stringContaining('settings table unreadable'));
    expect(state('acct_b').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
    expect(state('acct_c').flattened_record).toBe('v=spf1 ip4:192.0.2.1 -all');
  });

  it('does not log any account\'s token', async () => {
    const { cf, env, load } = setup();
    cf.failZone = { zoneId: 'zone-a', status: 403, message: 'Authentication error' };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await runCronForAccounts(SPF_CRON, env, ctx, { accounts: ['acct_a', 'acct_b', 'acct_c'], load });
    const logged = spies.flatMap(s => s.mock.calls.map(c => c.map(String).join(' '))).join('\n');
    for (const a of ACCOUNTS) expect(logged).not.toContain(a.token);
  });
});

describe('listCronAccounts', () => {
  it('self-host covers exactly the implicit account, without touching the database', async () => {
    expect(await listCronAccounts({ DB: undefined } as any)).toEqual(['acct_default']);
    expect(await listCronAccounts({ DB: undefined, MODE: 'selfhost' } as any)).toEqual(['acct_default']);
  });

  it('saas covers every account in the accounts table', async () => {
    const { env } = setup();
    expect(await listCronAccounts({ ...env, MODE: 'saas' } as any)).toEqual(['acct_default', 'acct_a', 'acct_b', 'acct_c']);
  });
});
