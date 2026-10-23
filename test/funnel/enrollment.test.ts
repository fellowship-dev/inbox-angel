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
import { provesDomain, topAuthResults } from '../../src/email/sender-proof';
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

  it('reads the topmost Authentication-Results from the raw header block, unfolding continuation lines, ignoring the body', async () => {
    expect(await topAuthResults(stream('Authentication-Results: mx.a;\r\n dkim=pass header.d=a.com\r\nAuthentication-Results: x; dkim=pass header.d=b.com\r\n\r\nAuthentication-Results: y; in-body'))).toBe('mx.a; dkim=pass header.d=a.com');
    expect(await topAuthResults(stream('Subject: x\r\n\r\nbody'))).toBeNull();
    expect(await topAuthResults(null)).toBeNull();
  });

  it('accepts an aligned DKIM pass or a DMARC pass for the address domain, and nothing weaker', () => {
    expect(provesDomain('mx; dkim=pass header.d=mail.acme.com', 'acme.com')).toBe(true); // aligned (organisational domain)
    expect(provesDomain('mx; dmarc=pass header.from=acme.com', 'acme.com')).toBe(true);
    expect(provesDomain('mx; dkim=pass header.d=esp.com; spf=pass smtp.mailfrom=a@acme.com', 'acme.com')).toBe(false);
    expect(provesDomain('mx; spf=pass smtp.mailfrom=a@acme.com', 'acme.com')).toBe(false);
    expect(provesDomain('mx; dkim=fail header.d=acme.com; dmarc=fail header.from=acme.com', 'acme.com')).toBe(false);
    expect(provesDomain(null, 'acme.com')).toBe(false);
  });

  it('with AUTHSERV_ID set the header must come from that server', () => {
    expect(provesDomain('mx.cloudflare.net; dkim=pass header.d=acme.com', 'acme.com', 'mx.cloudflare.net')).toBe(true);
    expect(provesDomain('evil.example; dkim=pass header.d=acme.com', 'acme.com', 'mx.cloudflare.net')).toBe(false);
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
