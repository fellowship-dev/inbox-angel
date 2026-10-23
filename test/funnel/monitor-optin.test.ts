import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hashEmail } from '@inbox-angel/db';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv } from '../auth/helpers';
import { expireUnconfirmedMonitors, runFunnelCron } from '../../src/funnel/cron';
import { signToken } from '../../src/mail/tokens';
import { makeTenant } from '../helpers/tenant';
import { quietLogs } from './world';

beforeEach(quietLogs);
afterEach(() => vi.restoreAllMocks());

function world(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn().mockResolvedValue({ messageId: 'm1' });
  const env = makeEnv(db, { BETTER_AUTH_SECRET: 's3cret', PUBLIC_BASE_URL: 'https://app.inboxangel.io', SEND_EMAIL: { send }, ...extra }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const seedCheck = (token: string, domain = 'acme.com') =>
    db.sqlite.prepare("INSERT INTO check_results (from_email, from_domain, spf_record, dmarc_policy, dmarc_record, session_token, overall_status) VALUES (?, ?, 'v=spf1 -all', 'none', 'v=DMARC1; p=none', ?, 'exposed')").run(`x@${domain}`, domain, token);
  const subscribe = (email: string, token = 'tok1', ip?: string) => call(env, 'POST', '/api/monitor', { body: { email, session_token: token }, ip });
  const linkFrom = (i = 0) => (send.mock.calls[i][0].text as string).match(/https:\/\/\S+\/api\/monitor\/confirm\?t=\S+/)![0].replace('https://app.inboxangel.io', '');
  return { db, env, send, rows, seedCheck, subscribe, linkFrom, tenant: () => makeTenant({ db, env }) };
}

describe('POST /api/monitor double opt-in', () => {
  it('subscribes nobody until the link is clicked: pending row, one confirmation email, no alerts', async () => {
    const w = world();
    w.seedCheck('tok1');
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (1, 'ws_default', 'acme.com', 'x')").run();
    const res = await w.subscribe('Victim@Example.com');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'pending_confirmation', domain: 'acme.com' });
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send.mock.calls[0][0].to).toEqual(['victim@example.com']);
    expect(w.rows('SELECT email, confirmed_at FROM monitor_subscriptions')).toEqual([{ email: 'victim@example.com', confirmed_at: null }]);
    expect(await w.tenant().scope.monitor.active()).toEqual([]); // not alerted
  });

  it('clicking the link activates it (no login), and only then is it checked for alerts', async () => {
    const w = world();
    w.seedCheck('tok1');
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (1, 'ws_default', 'acme.com', 'x')").run();
    await w.subscribe('user@example.com');
    const res = await call(w.env, 'POST', w.linkFrom());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Alerts confirmed');
    expect(w.rows('SELECT confirmed_at FROM monitor_subscriptions')[0].confirmed_at).toBeGreaterThan(0);
    expect((await w.tenant().scope.monitor.active()).map(s => s.email)).toEqual(['user@example.com']);
  });

  it('opening the link (GET: a mail security scanner does this) confirms nothing; it shows a button that POSTs', async () => {
    const w = world();
    w.seedCheck('tok1');
    await w.subscribe('user@example.com');
    const link = w.linkFrom();
    const page = await call(w.env, 'GET', link);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain('/api/monitor/confirm?t=');
    expect(html).not.toContain('Alerts confirmed');
    expect(w.rows('SELECT confirmed_at FROM monitor_subscriptions')).toEqual([{ confirmed_at: null }]);
    expect((await call(w.env, 'HEAD', link)).status).toBeLessThan(500);
    expect(w.rows('SELECT confirmed_at FROM monitor_subscriptions')).toEqual([{ confirmed_at: null }]);
  });

  it('a tampered, truncated or wrong-purpose link activates nothing', async () => {
    const w = world();
    w.seedCheck('tok1');
    await w.subscribe('user@example.com');
    const link = w.linkFrom();
    const [body, sig] = decodeURIComponent(link.split('t=')[1]).split('.');
    const forgedBody = btoa(JSON.stringify({ p: 'confirm', e: 'user@example.com', w: 'ws_default', s: 1, x: 4e9 })).replace(/=+$/, '');
    const unsub = await signToken(w.env, { p: 'unsub', e: 'user@example.com' });
    for (const bad of [`${forgedBody}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, body, unsub, 'x']) {
      for (const m of ['GET', 'POST']) expect((await call(w.env, m, `/api/monitor/confirm?t=${encodeURIComponent(bad)}`)).status, `${m} ${bad}`).toBe(400);
    }
    expect((await call(w.env, 'GET', '/api/monitor/confirm')).status).toBe(400);
    expect(w.rows('SELECT confirmed_at FROM monitor_subscriptions')).toEqual([{ confirmed_at: null }]);
  });

  it('an expired confirmation token is refused', async () => {
    const w = world();
    w.seedCheck('tok1');
    await w.subscribe('user@example.com');
    const id = w.rows('SELECT id FROM monitor_subscriptions')[0].id;
    const old = await signToken(w.env, { p: 'confirm', e: 'user@example.com', w: 'ws_default', s: id, x: Math.floor(Date.now() / 1000) - 1 });
    expect((await call(w.env, 'POST', `/api/monitor/confirm?t=${encodeURIComponent(old)}`)).status).toBe(400);
    expect(w.rows('SELECT confirmed_at FROM monitor_subscriptions')).toEqual([{ confirmed_at: null }]);
  });

  it('the link only confirms its own address: a token for another address does not match the row', async () => {
    const w = world();
    w.seedCheck('tok1');
    await w.subscribe('user@example.com');
    const id = w.rows('SELECT id FROM monitor_subscriptions')[0].id;
    const other = await signToken(w.env, { p: 'confirm', e: 'other@example.com', w: 'ws_default', s: id, x: 4e9 });
    expect((await call(w.env, 'POST', `/api/monitor/confirm?t=${encodeURIComponent(other)}`)).status).toBe(410);
    expect(w.rows('SELECT confirmed_at FROM monitor_subscriptions')).toEqual([{ confirmed_at: null }]);
  });

  it('unconfirmed subscriptions expire after 7 days; confirmed ones and fresh ones stay', async () => {
    const w = world();
    const now = 2_000_000_000;
    const ins = w.db.sqlite.prepare("INSERT INTO monitor_subscriptions (email, domain, created_at, confirmed_at, workspace_id) VALUES (?, ?, ?, ?, 'ws_default')");
    ins.run('old-unconfirmed@x.com', 'a.com', now - 7 * 86400 - 1, null);
    ins.run('fresh-unconfirmed@x.com', 'b.com', now - 7 * 86400 + 60, null);
    ins.run('old-confirmed@x.com', 'c.com', now - 90 * 86400, now - 89 * 86400);
    await expireUnconfirmedMonitors(w.tenant(), now);
    expect(w.rows('SELECT email FROM monitor_subscriptions ORDER BY email').map(r => r.email)).toEqual(['fresh-unconfirmed@x.com', 'old-confirmed@x.com']);
  });

  it('asking again for a confirmed address sends nothing; the answer is the same', async () => {
    const w = world();
    w.seedCheck('tok1');
    await w.subscribe('user@example.com');
    await call(w.env, 'POST', w.linkFrom());
    w.send.mockClear();
    expect((await w.subscribe('user@example.com')).status).toBe(202);
    expect(w.send).not.toHaveBeenCalled();
  });

  it('a suppressed address gets no email and no row, with the same answer', async () => {
    const w = world();
    w.seedCheck('tok1');
    w.db.sqlite.prepare('INSERT INTO suppression (email_hash, reason) VALUES (?, ?)').run(await hashEmail('user@example.com'), 'unsubscribe');
    expect((await w.subscribe('user@example.com')).status).toBe(202);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.rows('SELECT * FROM monitor_subscriptions')).toEqual([]);
  });

  it('limits confirmation emails per address per day, so it cannot be used to spam one inbox', async () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.seedCheck(`tok${i}`, `d${i}.com`);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await w.subscribe('victim@example.com', `tok${i}`)).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect(w.send).toHaveBeenCalledTimes(3);
  });

  it('one check session cannot be used to mail a list: 3 confirmations in total, then 429', async () => {
    const w = world();
    w.seedCheck('tok1');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await w.subscribe(`victim${i}@example.com`, 'tok1')).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    expect(w.send).toHaveBeenCalledTimes(3);
  });

  it('one client IP is capped per hour, whatever sessions it brings', async () => {
    const w = world();
    const sent: number[] = [];
    for (let i = 0; i < 22; i++) { w.seedCheck(`t${i}`, `d${i}.com`); sent.push((await w.subscribe(`v${i}@example.com`, `t${i}`, '198.51.100.9')).status); }
    expect(sent.filter(s => s === 202)).toHaveLength(20);
    expect(sent.slice(20)).toEqual([429, 429]);
    expect(w.send).toHaveBeenCalledTimes(20);
    expect(JSON.stringify(w.rows('SELECT key FROM auth_rate_limits'))).not.toContain('198.51.100.9');
    expect(JSON.stringify(w.rows('SELECT key FROM auth_rate_limits'))).not.toContain('v1@example.com');
  });

  it('the bare binding refusing an unverified address is reported, not hidden behind a 202 that never gets its email', async () => {
    const w = world();
    w.seedCheck('tok1');
    w.send.mockRejectedValueOnce(Object.assign(new Error('not verified'), { code: 'E_RECIPIENT_NOT_ALLOWED' }));
    const res = await w.subscribe('stranger@example.com');
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/cannot send a confirmation/);
  });

  it('with only Resend configured, the confirmation goes from MAIL_FROM over Resend', async () => {
    const w = world({ SEND_EMAIL: undefined, RESEND_API_KEY: 're_x', MAIL_FROM: 'max@inboxangel.io' });
    w.seedCheck('tok1');
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect((await w.subscribe('user@example.com')).status).toBe(202);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body)).toMatchObject({ from: 'Inbox Angel <max@inboxangel.io>', to: ['user@example.com'] });
    vi.unstubAllGlobals();
  });

  it('without any mail provider it says so and stores nothing', async () => {
    const w = world({ SEND_EMAIL: undefined });
    w.seedCheck('tok1');
    expect((await w.subscribe('user@example.com')).status).toBe(503);
    expect(w.rows('SELECT * FROM monitor_subscriptions')).toEqual([]);
  });

  it('runs the expiry from the daily cron tick only', async () => {
    const w = world();
    const now = 2_000_000_000;
    w.db.sqlite.prepare("INSERT INTO monitor_subscriptions (email, domain, created_at, workspace_id) VALUES ('a@x.com', 'a.com', ?, 'ws_default')").run(now - 8 * 86400);
    await runFunnelCron({ cron: '0 9 * * 1' }, w.env, now);
    expect(w.rows('SELECT * FROM monitor_subscriptions')).toHaveLength(1);
  });
});
