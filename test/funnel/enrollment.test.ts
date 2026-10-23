import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { hashEmail } from '@inbox-angel/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { handleHostedEmail } from '../../src/hosted/intake';
import { enrollLead } from '../../src/funnel/enroll';
import { DISCLOSURE } from '../../src/funnel/copy';
import { call, makeEnv } from '../auth/helpers';
import { fakeMessage } from '../helpers/mail';
import { nxdomain } from '../hosted/world';
import { proveSender, provesDomain, readAuthHeaders } from '../../src/email/sender-proof';
import { FUNNEL_ENV, T0, DAY, funnelWorld, quietLogs, rawWithAuth, summary } from './world';

const authFor = (d: string) => `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1; spf=pass smtp.mailfrom=u@${d}; dmarc=pass header.from=${d}`;

beforeEach(() => { quietLogs(); nxdomain(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...FUNNEL_ENV, ...extra }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  /** `auth`: the Authentication-Results headers in the raw message, topmost first (what the receiver added is first). */
  const check = async (from = 'user@example.com', auth: string | string[] | null = authFor('example.com')) => {
    const s = await (await call(env, 'POST', '/api/check-sessions')).json() as { email: string };
    const list = auth === null ? [] : Array.isArray(auth) ? auth : [auth];
    const m = fakeMessage(s.email, rawWithAuth(...list), { from, headers: { ...(list.length ? { 'authentication-results': list.join(', ') } : {}), 'message-id': '<m1@example.com>' } });
    await handleHostedEmail(m, env);
    return m;
  };
  return { db, env, rows, check };
}

/** The reply's decoded text: mimetext base64-encodes the bodies. */
const replyText = (m: any) => {
  const raw = (m.reply.mock.calls[0][0] as { raw: string }).raw;
  return raw + '\n' + [...raw.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]{20,})/g)].map(x => Buffer.from(x[1].replace(/\s/g, ''), 'base64').toString()).join('\n');
};

describe('enrolment on a hosted free check', () => {
  it('upserts the lead with its check level and summary, schedules day 1, and discloses it in the reply with an unsubscribe link', async () => {
    const t = hosted();
    const m = await t.check();
    expect(m.reply).toHaveBeenCalledOnce();
    const [lead] = t.rows('SELECT * FROM leads');
    expect(lead).toMatchObject({ email: 'user@example.com', domain: 'example.com', source: 'free_check', step: 0, status: 'active', unsubscribed_at: null });
    expect(['protected', 'at_risk', 'exposed']).toContain(lead.check_level);
    expect(JSON.parse(lead.check_summary)).toMatchObject({ domain: 'example.com', status: lead.check_level });
    expect(lead.next_send_at - lead.created_at).toBe(DAY);

    const text = replyText(m);
    expect(text).toContain(DISCLOSURE);
    expect(text).toMatch(/Unsubscribe: https:\/\/app\.inboxangel\.io\/api\/unsubscribe\?t=/);
    expect(text).toMatch(/List-Unsubscribe: <https:\/\/app\.inboxangel\.io\/api\/unsubscribe\?t=/i);
    expect(text).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
  });

  it('the disclosure is one plain sentence about a few short emails on fixing this and reaching BIMI', () => {
    expect(DISCLOSURE).toMatch(/few short emails/);
    expect(DISCLOSURE).toMatch(/BIMI/);
    expect(DISCLOSURE.split('\n')).toHaveLength(1);
  });

  it('a second check refreshes the lead but does not restart the sequence', async () => {
    const t = hosted();
    await t.check();
    t.db.sqlite.prepare('UPDATE leads SET step = 2, next_send_at = 123').run();
    await t.check();
    expect(t.rows('SELECT step, next_send_at FROM leads')).toEqual([{ step: 2, next_send_at: 123 }]);
  });

  it('a suppressed address is not enrolled and the reply has no disclosure', async () => {
    const t = hosted();
    t.db.sqlite.prepare('INSERT INTO suppression (email_hash, reason) VALUES (?, ?)').run(await hashEmail('user@example.com'), 'unsubscribe');
    const m = await t.check('User@Example.com');
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(m)).not.toContain(DISCLOSURE);
    expect(m.reply).toHaveBeenCalledOnce(); // the report itself is still sent
  });

  it('a sender whose domain did not authenticate is not enrolled (the address could be forged)', async () => {
    const t = hosted();
    const unauth = await t.check('victim@bank.com', null);
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(unauth)).not.toContain(DISCLOSURE);
    const other = await t.check('victim@bank.com', authFor('attacker.net'));
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(other)).not.toContain(DISCLOSURE);
  });

  it('a header the sender injected cannot make it pass: only the receiver\'s topmost Authentication-Results counts', async () => {
    const t = hosted();
    const real = 'mx.cloudflare.net; dkim=none; spf=fail smtp.mailfrom=ceo@victim.com; dmarc=fail header.from=victim.com';
    const injected = 'x; dkim=pass header.d=victim.com; spf=pass smtp.mailfrom=ceo@victim.com; dmarc=pass header.from=victim.com';
    const m = await t.check('ceo@victim.com', [real, injected]); // the receiver's header is on top, the attacker's below
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(m)).not.toContain(DISCLOSURE);
    // sanity: the same message with only the real pass does enrol
    await t.check('ceo@victim.com', authFor('victim.com'));
    expect(t.rows('SELECT email FROM leads')).toEqual([{ email: 'ceo@victim.com' }]);
  });

  it('a forged header above the real one (it names some other server) cannot make it pass', async () => {
    const t = hosted();
    const forged = 'attacker.example; dkim=pass header.d=victim.com; dmarc=pass header.from=victim.com';
    const real = 'mx.cloudflare.net; dkim=none; dmarc=fail header.from=victim.com';
    const m = await t.check('ceo@victim.com', [forged, real]);
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(m)).not.toContain(DISCLOSURE);
  });

  it('without AUTHSERV_ID nobody is enrolled, the report is still sent, and the log says why', async () => {
    const t = hosted({ AUTHSERV_ID: undefined });
    const m = await t.check();
    expect(m.reply).toHaveBeenCalledOnce();
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(m)).not.toContain(DISCLOSURE);
    expect(console.warn).toHaveBeenCalledWith('[free-check] sender not enrolled in the sequence: AUTHSERV_ID is not set');
  });

  it('without AUTHSERV_HEADER nobody is enrolled either, and the log says why', async () => {
    const t = hosted({ AUTHSERV_HEADER: undefined });
    const m = await t.check();
    expect(m.reply).toHaveBeenCalledOnce();
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('[free-check] sender not enrolled in the sequence: AUTHSERV_HEADER is not set');
  });

  it('enrols with AUTHSERV_HEADER=arc when only ARC-Authentication-Results carries our authserv-id', async () => {
    const t = hosted({ AUTHSERV_HEADER: 'arc' });
    const s = await (await call(t.env, 'POST', '/api/check-sessions')).json() as { email: string };
    const raw = 'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com\r\nSubject: hi\r\n\r\nhi';
    const m = fakeMessage(s.email, raw, { from: 'user@example.com', headers: { 'message-id': '<m1@example.com>' } });
    await handleHostedEmail(m, t.env);
    expect(t.rows('SELECT email FROM leads')).toEqual([{ email: 'user@example.com' }]);
    expect(replyText(m)).toContain(DISCLOSURE);
  });

  it('SPF alone is not enough, nor is a DMARC pass for a different From domain than the sender address', async () => {
    const t = hosted();
    await t.check('ceo@victim.com', 'mx.cloudflare.net; spf=pass smtp.mailfrom=bounce@victim.com; dkim=none; dmarc=none');
    await t.check('ceo@victim.com', 'mx.cloudflare.net; spf=pass smtp.mailfrom=x@attacker.net; dkim=pass header.d=attacker.net; dmarc=pass header.from=attacker.net');
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
  });

  it('the disclosure is shown only to leads who will actually get emails (active), not finished or bounced ones', async () => {
    const t = hosted();
    await t.check(); // enrolled
    for (const [status, shown] of [['active', true], ['completed', false], ['bounced', false], ['converted', false]] as const) {
      t.db.sqlite.prepare('UPDATE leads SET status = ?').run(status);
      expect(replyText(await t.check()).includes(DISCLOSURE), status).toBe(shown);
    }
  });

  it('is not enrolled when no unsubscribe link can be built', async () => {
    const t = hosted({ PUBLIC_BASE_URL: undefined });
    const m = await t.check();
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    expect(replyText(m)).not.toContain(DISCLOSURE);
  });

  it('hosted can switch it off with ONBOARDING_SEQUENCE_ENABLED=0', async () => {
    const t = hosted({ ONBOARDING_SEQUENCE_ENABLED: '0' });
    await t.check();
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
  });
});

describe('sender proof (unit)', () => {
  const stream = (s: string) => new Response(new TextEncoder().encode(s)).body!;
  const GOOD = 'mx.cloudflare.net; dkim=pass header.d=acme.com; dmarc=pass header.from=acme.com';
  const ID = 'mx.cloudflare.net';

  it('reads the topmost Authentication-Results and ARC-Authentication-Results from the raw header block, unfolding, ignoring the body', async () => {
    const h = await readAuthHeaders(stream('Authentication-Results: mx.a;\r\n dkim=pass header.d=a.com\r\nARC-Authentication-Results: i=1; mx.a; dkim=pass\r\nARC-Authentication-Results: i=2; evil; dkim=pass\r\nAuthentication-Results: x; dkim=pass header.d=b.com\r\n\r\nAuthentication-Results: y; in-body'));
    expect(h).toEqual({ ar: 'mx.a; dkim=pass header.d=a.com', arc: 'i=1; mx.a; dkim=pass' });
    expect(await readAuthHeaders(stream('Subject: x\r\n\r\nbody'))).toEqual({ ar: null, arc: null });
    expect(await readAuthHeaders(null)).toEqual({ ar: null, arc: null });
  });

  it('accepts an aligned DKIM pass or a DMARC pass for the address domain, and nothing weaker', () => {
    expect(provesDomain('mx; dkim=pass header.d=mail.acme.com', 'acme.com')).toBe(true);
    expect(provesDomain('mx; dmarc=pass header.from=acme.com', 'acme.com')).toBe(true);
    expect(provesDomain('mx; dkim=pass header.d=esp.com; spf=pass smtp.mailfrom=a@acme.com', 'acme.com')).toBe(false);
    expect(provesDomain('mx; spf=pass smtp.mailfrom=a@acme.com', 'acme.com')).toBe(false);
    expect(provesDomain('mx; dkim=fail header.d=acme.com; dmarc=fail header.from=acme.com', 'acme.com')).toBe(false);
    expect(provesDomain(null, 'acme.com')).toBe(false);
  });

  it('fails closed without AUTHSERV_ID, whatever the headers say', () => {
    for (const id of [undefined, '', '  ']) expect(proveSender({ ar: GOOD, arc: null }, 'acme.com', id, 'ar')).toEqual({ ok: false, reason: 'AUTHSERV_ID is not set' });
  });

  it('fails closed without AUTHSERV_HEADER (or with a value that is not ar/arc), even with both headers present and valid', () => {
    const both = { ar: GOOD, arc: 'i=1; mx.cloudflare.net; dkim=pass header.d=acme.com' };
    for (const only of [undefined, '', '  ', 'both', 'AUTHENTICATION-RESULTS']) expect(proveSender(both, 'acme.com', ID, only), String(only)).toEqual({ ok: false, reason: 'AUTHSERV_HEADER is not set' });
  });

  it('ar: the topmost Authentication-Results must name AUTHSERV_ID; a forged one above (another server) is refused', () => {
    expect(proveSender({ ar: GOOD, arc: null }, 'acme.com', ID, 'ar')).toEqual({ ok: true, via: 'ar' });
    const forged = proveSender({ ar: 'attacker.example; dkim=pass header.d=acme.com; dmarc=pass header.from=acme.com', arc: null }, 'acme.com', ID, 'ar');
    expect(forged).toMatchObject({ ok: false, reason: expect.stringContaining('names the configured AUTHSERV_ID') });
    expect(proveSender({ ar: GOOD.replace(ID, 'MX.Cloudflare.NET'), arc: null }, 'acme.com', ' mx.cloudflare.net ', ' AR ')).toMatchObject({ ok: true });
  });

  it('ar: a forged ARC header is not consulted (the sender can forge the kind the receiver does not add)', () => {
    expect(proveSender({ ar: null, arc: 'i=1; mx.cloudflare.net; dkim=pass header.d=acme.com' }, 'acme.com', ID, 'ar')).toMatchObject({ ok: false });
    expect(proveSender({ ar: 'mx.cloudflare.net; dkim=none; dmarc=fail header.from=acme.com', arc: 'i=1; mx.cloudflare.net; dkim=pass header.d=acme.com' }, 'acme.com', ID, 'ar')).toMatchObject({ ok: false });
  });

  it('arc: the topmost ARC-Authentication-Results with i=1 and our authserv-id; a plain header is not consulted', () => {
    const arc = (hop: string, id = ID) => ({ ar: null, arc: hop + '; ' + id + '; dkim=pass header.d=acme.com' });
    expect(proveSender(arc('i=1'), 'acme.com', ID, 'arc')).toEqual({ ok: true, via: 'arc' });
    expect(proveSender(arc('i=2'), 'acme.com', ID, 'arc')).toMatchObject({ ok: false });
    expect(proveSender(arc('i=1', 'evil.example'), 'acme.com', ID, 'arc')).toMatchObject({ ok: false });
    expect(proveSender({ ar: GOOD, arc: null }, 'acme.com', ID, 'arc')).toMatchObject({ ok: false });
    expect(proveSender({ ar: GOOD, arc: 'i=1; mx.cloudflare.net; dkim=fail header.d=acme.com; dmarc=none' }, 'acme.com', ID, 'arc')).toMatchObject({ ok: false });
  });
});

describe('enrollLead', () => {
  it('normalises the address, rejects junk, and reports what happened', async () => {
    const w = funnelWorld();
    expect(await enrollLead(w.env, { email: ' A@Acme.COM ', domain: 'Acme.com', summary: summary() }, T0)).toBe('enrolled');
    expect(w.rows('SELECT email, domain FROM leads')).toEqual([{ email: 'a@acme.com', domain: 'acme.com' }]);
    expect(await enrollLead(w.env, { email: 'a@acme.com', domain: 'acme.com', summary: summary({ status: 'protected' }) }, T0 + 5)).toBe('existing');
    expect(w.rows('SELECT check_level, last_activity_at FROM leads')).toEqual([{ check_level: 'protected', last_activity_at: T0 + 5 }]);
    expect(await enrollLead(w.env, { email: 'not-an-email', domain: 'x.com', summary: summary() })).toBe('disabled');
  });
});
