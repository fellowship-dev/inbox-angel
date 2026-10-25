// CORS and session rate limit, the self-host unknown-address drop, lead retention and the admin view.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleApi } from '../../src/api/router';
import { handleEmail } from '../../src/email/handler';
import { runFunnelCron, LEAD_RETENTION_SECONDS } from '../../src/funnel/cron';
import { isInstanceOwner } from '../../src/funnel/routes';
import { BASE, call, ctx, freshIp, inviteAndAccept, makeEnv, setupOwner } from '../auth/helpers';
import { fakeMessage } from '../helpers/mail';
import { makeTenant } from '../helpers/tenant';
import { nxdomain } from '../hosted/world';
import { DAY, funnelWorld, quietLogs, T0 } from './world';

beforeEach(() => { quietLogs(); nxdomain(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const SITE = 'https://inboxangel.io';

function selfHost(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'reports_domain', 'reports.acme.com')").run();
  const env = makeEnv(db, { SITE_ORIGINS: `${SITE}, https://www.inboxangel.io/`, ...extra }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, env0: env, rows };
}

const withOrigin = (env: any, method: string, path: string, origin: string | null, ip = freshIp()) =>
  handleApi(new Request(`${BASE}${path}`, { method, headers: { 'cf-connecting-ip': ip, ...(origin ? { origin } : {}) } }), env, ctx);

describe('CORS for the marketing site', () => {
  it('lets the SITE_ORIGINS call POST /api/check-sessions and GET /api/check-sessions/:token', async () => {
    const s = selfHost();
    for (const origin of [SITE, 'https://www.inboxangel.io']) {
      const post = await withOrigin(s.env, 'POST', '/api/check-sessions', origin);
      expect(post.status).toBe(201);
      expect(post.headers.get('access-control-allow-origin')).toBe(origin);
      expect(post.headers.get('vary')).toContain('Origin');
      expect(post.headers.get('access-control-allow-credentials')).toBeNull();
      const poll = await withOrigin(s.env, 'GET', '/api/check-sessions/abc', origin);
      expect(poll.status).toBe(202);
      expect(poll.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('answers preflights for allowed origins only', async () => {
    const s = selfHost();
    const ok = await withOrigin(s.env, 'OPTIONS', '/api/check-sessions', SITE);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(ok.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect((await withOrigin(s.env, 'OPTIONS', '/api/check-sessions/abc', SITE)).headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    const bad = await withOrigin(s.env, 'OPTIONS', '/api/check-sessions', 'https://evil.example');
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gives no CORS headers to other origins, to a lookalike, with no SITE_ORIGINS, or with a wildcard', async () => {
    const s = selfHost();
    for (const origin of ['https://evil.example', 'https://inboxangel.io.evil.example', 'http://inboxangel.io', null]) {
      expect((await withOrigin(s.env, 'POST', '/api/check-sessions', origin)).headers.get('access-control-allow-origin'), String(origin)).toBeNull();
    }
    const none = selfHost({ SITE_ORIGINS: undefined });
    expect((await withOrigin(none.env, 'POST', '/api/check-sessions', SITE)).headers.get('access-control-allow-origin')).toBeNull();
    const wild = selfHost({ SITE_ORIGINS: '*' });
    expect((await withOrigin(wild.env, 'POST', '/api/check-sessions', 'https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('applies to nothing else, not even for an allowed origin', async () => {
    const s = selfHost();
    for (const [method, path] of [['POST', '/api/unsubscribe'], ['GET', '/api/version'], ['GET', '/api/domains'], ['GET', '/api/unsubscribe'], ['GET', '/health']] as const) {
      const res = await withOrigin(s.env, method, path, SITE);
      expect(res.headers.get('access-control-allow-origin'), path).toBeNull();
    }
    expect((await withOrigin(s.env, 'OPTIONS', '/api/monitor', SITE)).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /api/check-sessions rate limit', () => {
  it('limits creation per IP and keeps counting per IP separately; the IP is stored only as a hash', async () => {
    const s = selfHost();
    const ip = '203.0.113.7';
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await withOrigin(s.env, 'POST', '/api/check-sessions', SITE, ip)).status);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(codes.slice(10)).toEqual([429, 429]);
    const limited = await withOrigin(s.env, 'POST', '/api/check-sessions', SITE, ip);
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(limited.headers.get('access-control-allow-origin')).toBe(SITE); // the browser can read the 429
    expect((await withOrigin(s.env, 'POST', '/api/check-sessions', SITE, '203.0.113.8')).status).toBe(201);
    expect(JSON.stringify(s.rows('SELECT key FROM auth_rate_limits'))).not.toContain(ip);
    expect(s.rows('SELECT key FROM auth_rate_limits')[0].key).toMatch(/^check-session:[0-9a-f]{32}$/); // keyed, not a plain hash
  });
});

describe('self-host: unknown inbound addresses', () => {
  const to = (local: string) => `${local}@reports.acme.com`;
  const deliver = async (s: ReturnType<typeof selfHost>, address: string) => {
    const m = fakeMessage(address, 'Subject: x\r\n\r\nhi', { from: 'someone@example.com', headers: { 'authentication-results': 'mx; spf=pass smtp.mailfrom=someone@example.com; dmarc=pass header.from=example.com' } });
    await handleEmail(m, makeTenant({ db: s.db, env: s.env, settings: { reportsDomain: 'reports.acme.com', fromEmail: 'noreply@reports.acme.com' } }), ctx);
    return m;
  };

  it.each([
    ['an arbitrary local part', 'info'],
    ['a forensic-report address', 'ruf'],
    ['the old bare-token form', 'abcd1234'],
    ['check+ with a token nobody issued', `check+${'a'.repeat(32)}`],
    ['check+ with a malformed token', 'check+short'],
  ])('%s is dropped with a log line: no reply, nothing stored', async (_n, local) => {
    const s = selfHost();
    const m = await deliver(s, to(local));
    expect(m.reply).not.toHaveBeenCalled();
    expect(m.setReject).toHaveBeenCalledWith('Unknown recipient');
    expect(s.rows('SELECT * FROM check_results')).toEqual([]);
    expect(s.rows('SELECT * FROM leads')).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('[email] dropped: unknown recipient', expect.any(String));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('someone@example.com');
  });

  it('a valid check+<token> issued by POST /api/check-sessions still runs the free check, once', async () => {
    const s = selfHost();
    const session = await (await call(s.env, 'POST', '/api/check-sessions')).json() as { token: string; email: string };
    expect(session.email).toBe(to(`check+${session.token}`));
    const m = await deliver(s, session.email);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(m.reply).toHaveBeenCalledOnce();
    expect(s.rows('SELECT session_token FROM check_results')).toEqual([{ session_token: session.token }]);
    const again = await deliver(s, session.email);
    expect(again.reply).not.toHaveBeenCalled();
    expect(again.setReject).toHaveBeenCalled();
  });

});

describe('lead retention', () => {
  it('deletes leads 12 months after the last activity, at the daily tick only', async () => {
    const w = funnelWorld({ RESEND_API_KEY: undefined });
    const now = T0 + 400 * DAY;
    await w.enroll('stale@acme.com', {}, now - LEAD_RETENTION_SECONDS - 1);
    await w.enroll('fresh@acme.com', {}, now - LEAD_RETENTION_SECONDS + 60);
    await runFunnelCron({ cron: '0 9 * * 1' }, w.env, now);
    expect(w.rows('SELECT * FROM leads')).toHaveLength(2);
    await runFunnelCron({ cron: '0 8 * * *' }, w.env, now);
    expect(w.rows('SELECT email FROM leads')).toEqual([{ email: 'fresh@acme.com' }]);
    expect(LEAD_RETENTION_SECONDS).toBe(365 * DAY);
  });

  it('a new check counts as activity and keeps the lead', async () => {
    const w = funnelWorld({ RESEND_API_KEY: undefined });
    const now = T0 + 400 * DAY;
    await w.enroll('a@acme.com', {}, T0);
    await w.enroll('a@acme.com', {}, now - DAY);
    await runFunnelCron({ cron: '0 8 * * *' }, w.env, now);
    expect(w.rows('SELECT * FROM leads')).toHaveLength(1);
  });
});

describe('admin view (instance owner only)', () => {
  it('lists leads with step, status, domain and level, and says why nothing is sending', async () => {
    const s = selfHost({ ONBOARDING_SEQUENCE_ENABLED: '1' });
    const owner = await setupOwner(s.env);
    s.db.sqlite.prepare("INSERT INTO leads (email, domain, check_level, step, next_send_at, created_at) VALUES ('lead@acme.com', 'acme.com', 'exposed', 1, 5, 4)").run();
    const res = await call(s.env, 'GET', '/api/leads', { key: owner });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.leads).toEqual([expect.objectContaining({ email: 'lead@acme.com', domain: 'acme.com', level: 'exposed', step: 1, steps_total: 5, status: 'active' })]);
    expect(body.counts).toEqual({ active: 1 });
    expect(body.delivery.can_send).toBe(false);
    expect(body.delivery.blockers.join(' ')).toMatch(/No mail provider/);
  });

  it('warns that MAIL_REPLY_TO is unset even when the onboarding sequence is off', async () => {
    const s = selfHost();
    const owner = await setupOwner(s.env);
    const body = await (await call(s.env, 'GET', '/api/leads', { key: owner })).json() as any;
    expect(body.delivery.enabled).toBe(false);
    expect(body.delivery.warnings.join(' ')).toMatch(/MAIL_REPLY_TO is not set/);
    const set = selfHost({ MAIL_REPLY_TO: 'hello@inboxangel.io' });
    const owner2 = await setupOwner(set.env);
    const body2 = await (await call(set.env, 'GET', '/api/leads', { key: owner2 })).json() as any;
    expect(body2.delivery.warnings.join(' ')).not.toMatch(/MAIL_REPLY_TO/);
  });

  it('is closed to members, admins who are not the instance owner, and the signed-out', async () => {
    const s = selfHost();
    const owner = await setupOwner(s.env, 'owner@example.com');
    const member = await inviteAndAccept(s.env, owner, 'm@example.com', 'member');
    const admin = await inviteAndAccept(s.env, owner, 'a@example.com', 'admin');
    expect((await call(s.env, 'GET', '/api/leads', { key: member })).status).toBe(403);
    expect((await call(s.env, 'GET', '/api/leads', { key: admin })).status).toBe(403);
    expect((await call(s.env, 'POST', '/api/leads/1/stop', { key: admin, body: { reason: 'booked' } })).status).toBe(403);
    expect((await call(s.env, 'GET', '/api/leads')).status).toBe(401);
    expect((await call(s.env, 'GET', '/api/leads', { key: owner })).status).toBe(200);
    expect(((await (await call(s.env, 'GET', '/api/me', { key: owner })).json()) as any).instance_owner).toBe(true);
    expect(((await (await call(s.env, 'GET', '/api/me', { key: admin })).json()) as any).instance_owner).toBe(false);
  });

  it('OWNER_EMAIL decides who the instance owner is', async () => {
    const s = selfHost({ OWNER_EMAIL: 'boss@example.com' });
    const owner = await setupOwner(s.env, 'boss@example.com');
    expect((await call(s.env, 'GET', '/api/leads', { key: owner })).status).toBe(200);
    expect(isInstanceOwner({ MODE: 'saas', OWNER_EMAIL: 'boss@example.com' }, { email: 'BOSS@example.com', workspaceId: 'ws_x', role: 'owner' })).toBe(true);
    expect(isInstanceOwner({ MODE: 'saas', OWNER_EMAIL: 'boss@example.com' }, { email: 'other@example.com', workspaceId: 'ws_default', role: 'owner' })).toBe(false);
    expect(isInstanceOwner({ MODE: 'saas' }, { email: 'x@example.com', workspaceId: 'ws_default', role: 'owner' })).toBe(false); // hosted needs OWNER_EMAIL
  });

  it('records that a lead replied, booked or bought, and rejects anything else', async () => {
    const s = selfHost();
    const owner = await setupOwner(s.env);
    s.db.sqlite.prepare("INSERT INTO leads (email, domain, next_send_at) VALUES ('lead@acme.com', 'acme.com', 5)").run();
    const id = s.rows('SELECT id FROM leads')[0].id;
    expect((await call(s.env, 'POST', `/api/leads/${id}/stop`, { key: owner, body: { reason: 'nonsense' } })).status).toBe(400);
    expect((await call(s.env, 'POST', '/api/leads/999/stop', { key: owner, body: { reason: 'booked' } })).status).toBe(404);
    expect((await call(s.env, 'POST', `/api/leads/${id}/stop`, { key: owner, body: { reason: 'booked' } })).status).toBe(200);
    expect(s.rows('SELECT status, next_send_at FROM leads')).toEqual([{ status: 'booked', next_send_at: null }]);
  });
});
