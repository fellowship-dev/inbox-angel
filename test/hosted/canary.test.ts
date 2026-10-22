import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';

// cloudflare:email only exists in workerd — stand-in that records the constructor args.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} },
}));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleHostedEmail } from '../../src/hosted/intake';
import { CANARY_GLOBAL_LIMIT, CANARY_PER_DOMAIN_LIMIT, CANARY_TTL_SECONDS, CANARY_UNAUTHENTICATED_LIMIT } from '../../src/hosted/canary';
import { hashToken } from '../../src/hosted/tokens';
import { call, makeEnv } from '../auth/helpers';
import { fakeMessage } from '../helpers/mail';
import { HOSTED_ENV, nxdomain, quiet } from './world';

const authFor = (d: string) => `mx.google.com; dkim=pass header.d=${d} header.s=s1; spf=pass smtp.mailfrom=u@${d}; dmarc=pass header.from=${d}`;
const AUTH = authFor('example.com');

function setup() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const issue = async () => {
    const res = await call(env, 'POST', '/api/check-sessions');
    expect(res.status).toBe(201);
    return await res.json() as { token: string; email: string; expires_at: number };
  };
  const send = async (to: string, from = 'user@example.com', auth: string | null = AUTH) => {
    const m = fakeMessage(to, 'Subject: hello\r\n\r\nhi', { from, headers: { ...(auth ? { 'authentication-results': auth } : {}), 'message-id': '<m1@example.com>' } });
    await handleHostedEmail(m, env);
    return m;
  };
  return { db, env, rows, issue, send };
}

beforeEach(() => { quiet(); nxdomain(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('canary (Check Email) addressing', () => {
  it('issues check+<token>@canary with an expiry; only the hash is stored', async () => {
    const t = setup();
    const before = Math.floor(Date.now() / 1000);
    const s = await t.issue();
    expect(s.email).toBe(`check+${s.token}@canary.inboxangel.io`);
    expect(s.token).toMatch(/^[a-z2-7]{32}$/);
    expect(s.expires_at).toBeGreaterThanOrEqual(before + CANARY_TTL_SECONDS);
    const stored = t.rows('SELECT * FROM canary_tokens');
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).toBe(await hashToken(s.token));
    expect(JSON.stringify(stored)).not.toContain(s.token);
  });

  it('resolves to an anonymous session: replies with the fixed free-check report, stores a global result, no account is involved', async () => {
    const t = setup();
    const s = await t.issue();
    const m = await t.send(s.email);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(m.reply).toHaveBeenCalledOnce();
    const reply = m.reply.mock.calls[0][0] as { from: string; to: string; raw: string };
    expect(reply.from).toBe('noreply@canary.inboxangel.io');
    expect(reply.to).toBe('user@example.com');
    expect(reply.raw).toMatch(/In-Reply-To: <m1@example\.com>/i);
    expect(Buffer.from(reply.raw.match(/Subject: =\?utf-8\?B\?([^?]+)\?=/i)![1], 'base64').toString()).toBe('Email security check — example.com');

    expect(t.rows('SELECT from_domain, session_token, overall_status FROM check_results')).toEqual([expect.objectContaining({ from_domain: 'example.com', session_token: s.token })]);
    // the browser polls by the same token
    const poll = await call(t.env, 'GET', `/api/check-sessions/${s.token}`);
    expect(poll.status).toBe(200);
    expect((await poll.json() as any).status).toBe('done');
    // nothing was written under any account
    for (const table of ['domains', 'audit_log', 'monitor_subscriptions']) {
      expect(t.rows(`SELECT * FROM ${table} WHERE account_id NOT IN ('acct_default')`)).toEqual([]);
    }
    expect(t.rows("SELECT * FROM settings WHERE account_id = '__anonymous__'")).toEqual([]);
  });

  it('is single use', async () => {
    const t = setup();
    const s = await t.issue();
    await t.send(s.email);
    const again = await t.send(s.email);
    expect(again.setReject).toHaveBeenCalledWith('This check address is unknown, expired or already used');
    expect(again.reply).not.toHaveBeenCalled();
  });

  it('expires', async () => {
    const t = setup();
    const s = await t.issue();
    t.db.sqlite.prepare('UPDATE canary_tokens SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    const m = await t.send(s.email);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(m.reply).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown token', () => 'check+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@canary.inboxangel.io'],
    ['a malformed token', () => 'check+short@canary.inboxangel.io'],
    ['no token', () => 'check@canary.inboxangel.io'],
    ['the wrong base address', () => 'rua+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@canary.inboxangel.io'],
  ])('%s is rejected', async (_n, to) => {
    const t = setup();
    const m = await t.send(to());
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(m.reply).not.toHaveBeenCalled();
    expect(t.rows('SELECT * FROM check_results')).toEqual([]);
  });

  it('rate-limits per authenticated sender domain, not per address', async () => {
    const t = setup();
    const accepted: boolean[] = [];
    for (let i = 0; i < CANARY_PER_DOMAIN_LIMIT + 2; i++) {
      const m = await t.send((await t.issue()).email, `person${i}@busy.example`, authFor('mail.busy.example'));
      accepted.push(m.reply.mock.calls.length === 1);
      if (!accepted[i]) expect(m.setReject.mock.calls[0][0]).toMatch(/Too many checks/);
    }
    expect(accepted).toEqual([...Array(CANARY_PER_DOMAIN_LIMIT).fill(true), false, false]);
    // another domain is unaffected, and subdomains share their registrable domain's allowance
    expect((await t.send((await t.issue()).email, 'x@calm.example', authFor('calm.example'))).reply).toHaveBeenCalledOnce();
    expect((await t.send((await t.issue()).email, 'x@busy.example', authFor('other.busy.example'))).reply).not.toHaveBeenCalled();
  });

  it('a spoofed From cannot use up a real domain’s allowance', async () => {
    const t = setup();
    for (let i = 0; i < CANARY_UNAUTHENTICATED_LIMIT + 3; i++) {
      await t.send((await t.issue()).email, 'ceo@victim.example', null); // claims victim.example, proves nothing
    }
    expect(t.rows("SELECT key FROM auth_rate_limits WHERE key LIKE 'canary:%victim%'")).toEqual([]);
    const real = await t.send((await t.issue()).email, 'ceo@victim.example', authFor('victim.example'));
    expect(real.reply).toHaveBeenCalledOnce();
  });

  it('unauthenticated senders share one small bucket', async () => {
    const t = setup();
    const outcomes: boolean[] = [];
    for (let i = 0; i < CANARY_UNAUTHENTICATED_LIMIT + 2; i++) outcomes.push((await t.send((await t.issue()).email, 'a@x.example', null)).reply.mock.calls.length === 1);
    expect(outcomes.filter(Boolean)).toHaveLength(CANARY_UNAUTHENTICATED_LIMIT);
  });

  it('a global hourly cap bounds the total', async () => {
    const t = setup();
    t.db.sqlite.prepare("INSERT INTO auth_rate_limits (id, key, count, last_request) VALUES ('g', 'canary:global', ?, ?)").run(CANARY_GLOBAL_LIMIT, Date.now());
    const m = await t.send((await t.issue()).email);
    expect(m.reply).not.toHaveBeenCalled();
    expect(m.setReject.mock.calls[0][0]).toMatch(/busy/);
  });
});
