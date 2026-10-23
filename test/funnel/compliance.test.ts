import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hashEmail } from '@inbox-angel/db';
import { signToken, verifyToken } from '../../src/mail/tokens';
import { sendNonTransactional, unsubscribeUrl } from '../../src/mail/compliance';
import { funnelMailer, ownerMailer, transactionalMailer } from '../../src/mail/mailer';
import { keyedHash } from '../../src/mail/tokens';
import { publicBaseUrl } from '../../src/funnel/config';
import { sendChangeNotification } from '../../src/monitor/notify';
import { handleApi } from '../../src/api/router';
import { makeTenant } from '../helpers/tenant';
import { ctx } from '../auth/helpers';
import { T0, fakeMailer, funnelWorld, quietLogs } from './world';

beforeEach(quietLogs);
afterEach(() => vi.restoreAllMocks());

const get = (env: any, path: string, method = 'GET') => handleApi(new Request(`https://app.inboxangel.io${path}`, { method, headers: { 'cf-connecting-ip': '9.9.9.9' } }), env, ctx);
const tokenOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get('t')!);

describe('signed tokens', () => {
  it('round-trips an unsubscribe token (no expiry) and rejects any tampering', async () => {
    const w = funnelWorld();
    const t = await signToken(w.env, { p: 'unsub', e: 'a@acme.com' });
    expect(await verifyToken(w.env, t, T0 * 1000)).toEqual({ p: 'unsub', e: 'a@acme.com' });

    const [body, sig] = t.split('.');
    const forged = btoa(JSON.stringify({ p: 'unsub', e: 'victim@acme.com' })).replace(/=+$/, '');
    // the address is not readable in the token, in plain text or as base64
    expect(t).not.toContain('acme');
    expect(Buffer.from(body, 'base64url').toString('latin1')).not.toContain('acme');
    expect(await signToken(w.env, { p: 'unsub', e: 'a@acme.com' })).not.toBe(t); // random IV
    const flip = (s: string) => s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    for (const bad of [`${forged}.${sig}`, `${body}.${flip(sig)}`, `${flip(body)}.${sig}`, `${body}`, `${body}.${sig}.x`, '', 'a.b']) {
      expect(await verifyToken(w.env, bad), bad).toBeNull();
    }
  });

  it('a token under another secret is rejected', async () => {
    const a = funnelWorld({ BETTER_AUTH_SECRET: 'one' });
    const b = funnelWorld({ BETTER_AUTH_SECRET: 'two' });
    expect(await verifyToken(b.env, await signToken(a.env, { p: 'unsub', e: 'a@acme.com' }))).toBeNull();
  });

  it('confirmation tokens expire', async () => {
    const w = funnelWorld();
    const t = await signToken(w.env, { p: 'confirm', e: 'a@acme.com', w: 'ws_default', s: 1, x: 1000 });
    expect(await verifyToken(w.env, t, 999)).toMatchObject({ s: 1 });
    expect(await verifyToken(w.env, t, 1000)).toBeNull();
  });
});

describe('GET|POST /api/unsubscribe', () => {
  async function seeded() {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    w.db.sqlite.prepare("INSERT INTO monitor_subscriptions (email, domain, workspace_id) VALUES ('a@acme.com', 'acme.com', 'ws_default')").run();
    const link = (await unsubscribeUrl(w.env, 'A@acme.com'))!;
    return { w, link, path: link.replace('https://app.inboxangel.io', '') };
  }

  it('the link in the email body unsubscribes: suppression hash kept, lead and subscriptions deleted at once, no login needed', async () => {
    const { w, path } = await seeded();
    const res = await get(w.env, path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('You are unsubscribed');
    expect(w.rows('SELECT * FROM leads')).toEqual([]);
    expect(w.rows('SELECT * FROM monitor_subscriptions')).toEqual([]);
    expect(w.rows('SELECT * FROM suppression')).toEqual([{ email_hash: await hashEmail('a@acme.com'), reason: 'unsubscribe', created_at: expect.any(Number) }]);
    expect(JSON.stringify(w.rows('SELECT * FROM suppression'))).not.toContain('a@acme.com');
  });

  it('the RFC 8058 one-click POST works too, and repeating it is harmless', async () => {
    const { w, path } = await seeded();
    expect((await get(w.env, path, 'POST')).status).toBe(200);
    expect((await get(w.env, path, 'POST')).status).toBe(200);
    expect(w.rows('SELECT * FROM suppression')).toHaveLength(1);
    expect(w.rows('SELECT * FROM leads')).toEqual([]);
  });

  it('a tampered token changes nothing', async () => {
    const { w, link } = await seeded();
    const t = tokenOf(link);
    const forged = `${btoa(JSON.stringify({ p: 'unsub', e: 'a@acme.com' })).replace(/=+$/, '')}.${t.split('.')[1].slice(0, -3)}AAA`;
    for (const bad of [forged, `${t}x`, 'garbage']) {
      for (const method of ['GET', 'POST']) {
        const res = await get(w.env, `/api/unsubscribe?t=${encodeURIComponent(bad)}`, method);
        expect(res.status).toBe(400);
      }
    }
    expect((await get(w.env, '/api/unsubscribe')).status).toBe(400);
    expect(w.rows('SELECT * FROM suppression')).toEqual([]);
    expect(w.rows('SELECT * FROM leads')).toHaveLength(1);
  });

  it('a confirmation token cannot be used to unsubscribe', async () => {
    const w = funnelWorld();
    const t = await signToken(w.env, { p: 'confirm', e: 'a@acme.com', w: 'ws_default', s: 1, x: 2e12 });
    expect((await get(w.env, `/api/unsubscribe?t=${encodeURIComponent(t)}`)).status).toBe(400);
  });
});

describe('sendNonTransactional', () => {
  it('does not send to a suppressed address', async () => {
    const w = funnelWorld();
    await w.db.sqlite.prepare('INSERT INTO suppression (email_hash, reason) VALUES (?, ?)').run(await hashEmail('a@acme.com'), 'unsubscribe');
    const m = fakeMailer();
    const out = await sendNonTransactional(w.env, m, { from: { email: 'x@y.io' }, to: ' A@Acme.com ', subject: 's', text: 't' });
    expect(out).toMatchObject({ ok: false, kind: 'suppressed' });
    expect(m.sent).toEqual([]);
  });

  it('hosted: refuses to send without an unsubscribe link; self-host: sends with the footer but no link', async () => {
    const hosted = funnelWorld({ PUBLIC_BASE_URL: undefined });
    expect(await sendNonTransactional(hosted.env, fakeMailer(), { from: { email: 'x@y.io' }, to: 'a@acme.com', subject: 's', text: 't' })).toMatchObject({ ok: false, kind: 'blocked' });

    const self = funnelWorld({ PUBLIC_BASE_URL: undefined, MODE: undefined, SAAS_ENABLED: undefined });
    const m = fakeMailer();
    expect((await sendNonTransactional(self.env, m, { from: { email: 'x@y.io' }, to: 'a@acme.com', subject: 's', text: 't' })).ok).toBe(true);
    expect(m.sent[0].headers).toEqual({});
    expect(m.sent[0].text).toContain('Wilmington');
  });
});

describe('change alerts (non-transactional)', () => {
  const change = { field: 'DMARC policy', was: 'reject', now: 'none', severity: 'degraded' as const };

  it('carry unsubscribe headers, link and postal footer, and skip suppressed addresses', async () => {
    const w = funnelWorld(); // a Resend key is configured: owner-facing alerts must still use the binding
    const resendFetch = vi.fn();
    vi.stubGlobal('fetch', resendFetch);
    const send = vi.fn().mockResolvedValue({ messageId: 'm' });
    const tenant = makeTenant({ db: w.db, env: { ...w.env, SEND_EMAIL: { send } as any } });
    await sendChangeNotification('a@acme.com', 'acme.com', [change], tenant);
    expect(send).toHaveBeenCalledOnce();
    const arg = send.mock.calls[0][0];
    expect(arg.headers['List-Unsubscribe']).toMatch(/^<https:\/\/app\.inboxangel\.io\/api\/unsubscribe\?t=.+>$/);
    expect(arg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(arg.text).toContain('Unsubscribe: https://app.inboxangel.io/api/unsubscribe');
    expect(arg.text).toContain('Wilmington');
    expect(arg.html).toContain('Unsubscribe</a>');

    await w.db.sqlite.prepare('INSERT INTO suppression (email_hash, reason) VALUES (?, ?)').run(await hashEmail('a@acme.com'), 'unsubscribe');
    await sendChangeNotification('a@acme.com', 'acme.com', [change], tenant);
    expect(send).toHaveBeenCalledOnce();
    expect(resendFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('mailers by purpose', () => {
  it('funnel mail is Resend only; owner mail is the binding only; confirmations prefer the binding', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'cf1' });
    const binding = { send } as any;
    expect(funnelMailer({ RESEND_API_KEY: 'k' })).toMatchObject({ provider: 'resend', arbitraryRecipients: true });
    expect(funnelMailer({ SEND_EMAIL: binding })).toBeNull(); // Cloudflare Email Service is transactional-only
    expect(funnelMailer({})).toBeNull();
    expect(ownerMailer({ RESEND_API_KEY: 'k' })).toBeNull();
    expect(ownerMailer({ SEND_EMAIL: binding })).toMatchObject({ provider: 'binding' });
    expect(transactionalMailer({ SEND_EMAIL: binding, RESEND_API_KEY: 'k' })).toMatchObject({ provider: 'binding' });
    expect(transactionalMailer({ RESEND_API_KEY: 'k' })).toMatchObject({ provider: 'resend' });
    expect(transactionalMailer({})).toBeNull();

    const m = ownerMailer({ SEND_EMAIL: binding })!;
    expect(await m.send({ from: { name: 'N', email: 'f@x.io' }, to: 'a@b.co', subject: 's', text: 't', headers: { 'List-Unsubscribe': '<https://x>' } })).toEqual({ ok: true, id: 'cf1' });
    expect(send.mock.calls[0][0]).toMatchObject({ from: { name: 'N', email: 'f@x.io' }, to: ['a@b.co'], headers: { 'List-Unsubscribe': '<https://x>' } });
  });

  it('classifies provider errors', async () => {
    const codes = (code: string) => ownerMailer({ SEND_EMAIL: { send: async () => { throw Object.assign(new Error('x'), { code }); } } as any })!.send({ from: { email: 'f@x.io' }, to: 'a@b.co', subject: 's', text: 't' });
    expect(await codes('E_RECIPIENT_SUPPRESSED')).toMatchObject({ ok: false, kind: 'recipient' });
    expect(await codes('E_HEADER_NOT_ALLOWED')).toMatchObject({ ok: false, kind: 'config' });
    expect(await codes('E_SOMETHING')).toMatchObject({ ok: false, kind: 'transient' });

    const resend = (status: number, message: string) => funnelMailer({ RESEND_API_KEY: 'k' }, (async () => new Response(JSON.stringify({ message }), { status })) as any)!.send({ from: { email: 'f@x.io' }, to: 'a@b.co', subject: 's', text: 't' });
    expect(await resend(429, 'slow')).toMatchObject({ kind: 'transient' });
    expect(await resend(503, 'down')).toMatchObject({ kind: 'transient' });
    expect(await resend(422, 'Invalid `to` field')).toMatchObject({ kind: 'recipient' });
    expect(await resend(422, 'Invalid `from` field')).toMatchObject({ kind: 'config' });
    expect(await resend(401, 'API key is invalid')).toMatchObject({ kind: 'config' });
  });
});

describe('privacy of rate-limit keys and link base', () => {
  it('keyed hashes are stable per secret and differ across secrets and purposes (a plain hash of an IPv4 can be enumerated)', async () => {
    const a = funnelWorld({ BETTER_AUTH_SECRET: 'one' });
    const b = funnelWorld({ BETTER_AUTH_SECRET: 'two' });
    const h = await keyedHash(a.env, 'ip', '203.0.113.7');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyedHash(a.env, 'ip', '203.0.113.7')).toBe(h);
    expect(await keyedHash(b.env, 'ip', '203.0.113.7')).not.toBe(h);
    expect(await keyedHash(a.env, 'email', '203.0.113.7')).not.toBe(h);
    expect(h).not.toBe((await import('node:crypto')).createHash('sha256').update('203.0.113.7').digest('hex').slice(0, 32));
  });

  it('links are HTTPS only (plain-HTTP List-Unsubscribe is rejected by providers); http is accepted for localhost', () => {
    const base = (v?: string) => publicBaseUrl({ PUBLIC_BASE_URL: v } as any);
    expect(base('https://app.inboxangel.io/')).toBe('https://app.inboxangel.io');
    expect(base('http://app.inboxangel.io')).toBeNull();
    expect(base('http://localhost:8787')).toBe('http://localhost:8787');
    expect(base('http://localhost.evil.com')).toBeNull();
    expect(base(undefined)).toBeNull();
  });
});
