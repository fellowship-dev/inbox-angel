// Integration-style tests for handleFreeCheck.
// All I/O (fetch, D1, message.reply) is mocked — no network required.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cloudflare:email only exists in workerd — stand-in that records the constructor args.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

import { handleFreeCheck, buildReplyRaw } from '../../src/email/free-check';
import type { Env } from '../../src/index';
import { makeTenant } from '../helpers/tenant';
import { createMigratedD1 } from '@inbox-angel/db/testing';

// ── Helpers ───────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  const db = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
  } as unknown as D1Database;

  return {
    DB: db,
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_ZONE_ID: '',
    CLOUDFLARE_API_TOKEN: '',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    FROM_EMAIL: 'check@reports.inboxangel.io',
    ...overrides,
  };
}

/** The tenant a test env belongs to. */
function tn(env: Env) {
  return makeTenant({ db: env.DB, settings: { reportsDomain: 'reports.inboxangel.io', fromEmail: 'check@reports.inboxangel.io' } });
}

function makeMessage(overrides: Partial<{
  from: string;
  to: string;
  authResults: string;
  raw: string;
  messageId: string;
}>= {}): ForwardableEmailMessage {
  const authHeader = overrides.authResults ?? [
    'mx.google.com;',
    ' dkim=pass header.d=example.com header.s=selector1;',
    ' spf=pass smtp.mailfrom=user@example.com;',
    ' dmarc=pass (p=reject dis=none) header.from=example.com',
  ].join('');

  const headers = new Headers({ 'authentication-results': authHeader, 'message-id': overrides.messageId ?? '<orig-123@mail.example.com>' });

  return {
    ...(overrides.raw !== undefined ? { raw: rawStream(overrides.raw) } : {}),
    from: overrides.from ?? 'user@example.com',
    to: overrides.to ?? 'check@reports.inboxangel.io',
    headers,
    reply: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function rawStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

/** The receiver's own results (AUTHSERV_ID mx.cloudflare.net) on top, then whatever the sender wrote, then the body. */
function rawWith(trusted: string | null, forged: string[] = []): string {
  return [
    ...(trusted ? [`Authentication-Results: mx.cloudflare.net; ${trusted}`] : []),
    ...forged.map(f => `Authentication-Results: ${f}`),
    'From: user@example.com',
    'Subject: check',
    '',
    'hi',
  ].join('\r\n');
}
const AUTHSERV = { AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };

// Mock DoH responses for SPF/DMARC/DKIM
function mockDohAll() {
  vi.mocked(fetch)
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        Answer: [{ type: 16, data: '"v=spf1 include:_spf.google.com -all"' }],
      }),
    } as unknown as Response)  // SPF
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        Answer: [{ type: 16, data: '"v=DMARC1; p=reject; pct=100"' }],
      }),
    } as unknown as Response)  // DMARC
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        Answer: [{ type: 16, data: '"v=DKIM1; k=rsa; p=ABC"' }],
      }),
    } as unknown as Response); // DKIM
}

function mockDohEmpty() {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ Answer: [] }),
  } as unknown as Response);
}

// ── Tests ─────────────────────────────────────────────────────

describe('handleFreeCheck', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  // mimetext RFC 2047-encodes From name / Subject; decode so assertions read naturally.
  const decodeWords = (raw: string) => raw.replace(/=\?utf-8\?B\?([^?]+)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));

  function sentReply(message: ForwardableEmailMessage) {
    return (message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { from: string; to: string; raw: string };
  }

  it('replies with an EmailMessage (envelope from/to + raw MIME), not a stream', async () => {
    mockDohAll();
    const message = makeMessage();

    await handleFreeCheck(message, tn(makeEnv()), 'test-token');

    expect(message.reply).toHaveBeenCalledOnce();
    const reply = sentReply(message);
    expect(reply).not.toBeInstanceOf(ReadableStream);
    expect(reply.from).toBe('check@reports.inboxangel.io');
    expect(reply.to).toBe('user@example.com');
    expect(typeof reply.raw).toBe('string');
  });

  it('threads the reply with In-Reply-To / References from the original Message-ID', async () => {
    mockDohAll();
    const message = makeMessage();

    await handleFreeCheck(message, tn(makeEnv()), 'test-token');

    const { raw } = sentReply(message);
    expect(raw).toMatch(/In-Reply-To: <orig-123@mail\.example\.com>/i);
    expect(raw).toMatch(/References: <orig-123@mail\.example\.com>/i);
  });

  it('MIME reply contains domain name', async () => {
    mockDohAll();
    const message = makeMessage({ from: 'founder@startupxyz.com' });

    await handleFreeCheck(message, tn(makeEnv()), 'test-token');

    expect(sentReply(message).raw).toContain('startupxyz.com');
  });

  it('MIME reply has From, To, Subject and both text and html parts', async () => {
    mockDohAll();
    const message = makeMessage();

    await handleFreeCheck(message, tn(makeEnv()), 'test-token');

    const raw = decodeWords(sentReply(message).raw);
    expect(raw).toMatch(/From: "?InboxAngel"? <check@reports\.inboxangel\.io>/);
    expect(raw).toMatch(/To: <?user@example\.com>?/);
    expect(raw).toMatch(/Subject: Email security check — example\.com/);
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
  });

  it('stores result in D1', async () => {
    mockDohAll();
    const message = makeMessage();
    const env = makeEnv();

    await handleFreeCheck(message, tn(env), 'test-token');

    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it('extracts domain from from address correctly', async () => {
    mockDohAll();
    const message = makeMessage({ from: 'hello@my-company.io' });
    const env = makeEnv();

    await handleFreeCheck(message, tn(env), 'test-token');

    expect(sentReply(message).raw).toContain('my-company.io');
  });

  it('still sends reply even when all DNS lookups return nothing', async () => {
    mockDohEmpty();
    const message = makeMessage();
    const env = makeEnv();

    await handleFreeCheck(message, tn(env), 'test-token');

    expect(message.reply).toHaveBeenCalledOnce();
  });

  it('report says "exposed" when DNS is empty', async () => {
    mockDohEmpty();
    const message = makeMessage({
      authResults: 'mx.example.com; spf=fail smtp.mailfrom=user@example.com',
    });
    const env = makeEnv();

    await handleFreeCheck(message, tn(env), 'test-token');

    expect(sentReply(message).raw).toContain('🚨'); // exposed status line
  });

  it('handles missing Authentication-Results header gracefully', async () => {
    mockDohEmpty();
    const message: ForwardableEmailMessage = {
      from: 'user@nodomain.com',
      to: 'check@reports.inboxangel.io',
      headers: new Headers(), // no auth-results
      reply: vi.fn().mockResolvedValue(undefined),
      forward: vi.fn(),
      setReject: vi.fn(),
    } as unknown as ForwardableEmailMessage;

    const env = makeEnv();
    await handleFreeCheck(message, tn(env), 'test-token');

    expect(message.reply).toHaveBeenCalledOnce();
  });

  it('does not throw when D1 insert fails', async () => {
    mockDohAll();
    const message = makeMessage();
    const brokenDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
        }),
      }),
    } as unknown as D1Database;

    const env = makeEnv({ DB: brokenDb });
    // Should not throw — DB failure is swallowed with console.error
    const result = await handleFreeCheck(message, tn(env), 'test-token');
    expect(result).toHaveProperty('result');
    expect(message.reply).toHaveBeenCalledOnce();
  });
});

// Cloudflare documents that message.reply() throws unless the incoming email has a valid DMARC result (among other rules),
// so a sender whose domain has no DMARC would get nothing. The same report then goes out as a new email via SEND_EMAIL.
describe('handleFreeCheck: delivery when reply() is refused', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  type Sent = { from: { name?: string; email: string } | string; to: string[]; subject: string; text: string; html?: string; replyTo?: string; headers?: Record<string, string> };

  function setup(opts: { replyFails?: boolean; sendFails?: boolean; binding?: boolean; env?: Record<string, unknown>; raw?: string; from?: string } = {}) {
    const db = createMigratedD1();
    const sent: Sent[] = [];
    const SEND_EMAIL = {
      send: vi.fn(async (m: Sent) => {
        if (opts.sendFails) throw Object.assign(new Error('not allowed'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
        sent.push(m);
        return { messageId: 'm-1' };
      }),
    };
    const tenant = makeTenant({
      db,
      env: { ...(opts.binding === false ? {} : { SEND_EMAIL }), ...AUTHSERV, ...opts.env } as never,
      settings: { reportsDomain: 'reports.inboxangel.io', fromEmail: 'check@reports.inboxangel.io' },
    });
    const message = makeMessage({
      from: opts.from,
      authResults: 'mx.cloudflare.net; spf=none smtp.mailfrom=user@example.com; dmarc=none header.from=example.com',
      raw: opts.raw ?? rawWith('spf=pass smtp.mailfrom=user@example.com; dmarc=none header.from=example.com'),
    });
    if (opts.replyFails) (message.reply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('original email is not repliable'));
    const rows = () => db.sqlite.prepare('SELECT from_email, report_sent, overall_status FROM check_results').all() as Array<{ from_email: string; report_sent: number; overall_status: string }>;
    return { tenant, message, sent, SEND_EMAIL, rows };
  }

  it('reply() succeeds: nothing is sent through SEND_EMAIL', async () => {
    mockDohEmpty();
    const { tenant, message, SEND_EMAIL, rows } = setup();
    await handleFreeCheck(message, tenant, 'tok');
    expect(message.reply).toHaveBeenCalledOnce();
    expect(SEND_EMAIL.send).not.toHaveBeenCalled();
    expect(rows()).toEqual([expect.objectContaining({ from_email: 'user@example.com', report_sent: 1 })]);
  });

  it('reply() throws: one email through SEND_EMAIL to the sender, same subject and body, threaded', async () => {
    mockDohEmpty();
    const { tenant, message, sent, rows } = setup({ replyFails: true });
    await handleFreeCheck(message, tenant, 'tok');
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toEqual(['user@example.com']);
    expect(m.from).toEqual({ name: 'InboxAngel', email: 'check@reports.inboxangel.io' });
    expect(m.subject).toBe('Email security check — example.com');
    expect(m.text).toContain('example.com');
    expect(m.text).toContain('🚨');
    expect(m.html).toContain('example.com');
    expect(m.headers).toMatchObject({ 'In-Reply-To': '<orig-123@mail.example.com>', References: '<orig-123@mail.example.com>' });
    expect(rows()).toEqual([expect.objectContaining({ from_email: 'user@example.com', report_sent: 1 })]);
  });

  it('reply() and the send both fail: the error is logged and the check result is still stored as not sent', async () => {
    mockDohEmpty();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tenant, message, rows } = setup({ replyFails: true, sendFails: true });
    const result = await handleFreeCheck(message, tenant, 'tok');
    expect(result.result).toBe('exposed');
    expect(rows()).toEqual([expect.objectContaining({ from_email: 'user@example.com', report_sent: 0, overall_status: 'exposed' })]);
    expect(errors.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/free-check: report not delivered/);
    errors.mockRestore();
  });

  it('reply() throws and no SEND_EMAIL binding: logged, still stored as not sent', async () => {
    mockDohEmpty();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tenant, message, rows } = setup({ replyFails: true, binding: false });
    await handleFreeCheck(message, tenant, 'tok');
    expect(rows()).toEqual([expect.objectContaining({ report_sent: 0 })]);
    expect(errors.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/free-check: report not delivered/);
    errors.mockRestore();
  });

  // The fallback is a new email to the envelope sender, which reply() refused to prove. Without proof it would reflect a
  // report (partly worded by whoever forged the sender) at a victim, so it needs the receiver's own SPF pass for that address.
  it('spoofed sender (no trusted SPF pass) and reply() throws: nothing is sent, stored as not sent', async () => {
    mockDohEmpty();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tenant, message, SEND_EMAIL, rows } = setup({
      replyFails: true, from: 'victim@example.com',
      raw: rawWith('spf=fail smtp.mailfrom=victim@example.com; dmarc=fail header.from=example.com', ['mx.cloudflare.net; spf=pass smtp.mailfrom=victim@example.com']),
    });
    await handleFreeCheck(message, tenant, 'tok');
    expect(SEND_EMAIL.send).not.toHaveBeenCalled();
    expect(rows()).toEqual([expect.objectContaining({ from_email: 'victim@example.com', report_sent: 0 })]);
    warn.mockRestore();
  });

  it('trusted SPF pass for another domain than the envelope sender: nothing is sent', async () => {
    mockDohEmpty();
    const { tenant, message, SEND_EMAIL } = setup({ replyFails: true, raw: rawWith('spf=pass smtp.mailfrom=bounce@attacker.example') });
    await handleFreeCheck(message, tenant, 'tok');
    expect(SEND_EMAIL.send).not.toHaveBeenCalled();
  });

  it('trusted SPF pass for the envelope sender: exactly one send', async () => {
    mockDohEmpty();
    const { tenant, message, SEND_EMAIL } = setup({ replyFails: true });
    await handleFreeCheck(message, tenant, 'tok');
    expect(SEND_EMAIL.send).toHaveBeenCalledOnce();
  });

  it('AUTHSERV_ID unset: no send even with an SPF pass, stored as not sent', async () => {
    mockDohEmpty();
    const { tenant, message, SEND_EMAIL, rows } = setup({ replyFails: true, env: { AUTHSERV_ID: undefined } });
    await handleFreeCheck(message, tenant, 'tok');
    expect(SEND_EMAIL.send).not.toHaveBeenCalled();
    expect(rows()).toEqual([expect.objectContaining({ report_sent: 0 })]);
  });

  it('fallback body is built from the trusted header only: forged Authentication-Results values never appear', async () => {
    mockDohEmpty();
    const { tenant, message, sent } = setup({
      replyFails: true,
      raw: rawWith('spf=pass smtp.mailfrom=user@example.com', ['evil.example; dkim=pass header.d=pwned-click-here.example header.s=forgedsel99']),
    });
    // What Headers.get() would return: every Authentication-Results joined, the forged one included.
    message.headers.set('authentication-results', 'mx.cloudflare.net; spf=pass smtp.mailfrom=user@example.com, evil.example; dkim=pass header.d=pwned-click-here.example header.s=forgedsel99');
    await handleFreeCheck(message, tenant, 'tok');
    expect(sent).toHaveLength(1);
    for (const body of [sent[0].text, sent[0].html ?? '']) {
      expect(body).not.toContain('pwned-click-here');
      expect(body).not.toContain('forgedsel99');
    }
    // and the forged selector was not used for a DNS lookup
    expect(vi.mocked(fetch).mock.calls.map(c => String(c[0])).join(' ')).not.toContain('forgedsel99');
  });

  it('forwards the sender Message-ID for threading only when it is a single <id>', async () => {
    mockDohEmpty();
    const { tenant, message, sent } = setup({ replyFails: true });
    message.headers.set('message-id', '<a@b> <c@d>');
    await handleFreeCheck(message, tenant, 'tok');
    expect(sent[0].headers?.['In-Reply-To']).toBeUndefined();
    expect(sent[0].headers?.References).toBeUndefined();
  });
});

describe('handleFreeCheck: replies reach the operator, links use SITE_URL', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  function run(env: Record<string, unknown>, replyFails = false, trustedAuth = 'spf=pass smtp.mailfrom=user@example.com; dmarc=none header.from=example.com') {
    const sent: Array<{ replyTo?: string; text: string; html?: string }> = [];
    const SEND_EMAIL = { send: vi.fn(async (m: { replyTo?: string; text: string; html?: string }) => { sent.push(m); return { messageId: 'm' }; }) };
    const tenant = makeTenant({ db: createMigratedD1(), env: { SEND_EMAIL, ...AUTHSERV, ...env } as never, settings: { reportsDomain: 'reports.inboxangel.io', fromEmail: 'check@reports.inboxangel.io' } });
    const message = makeMessage({
      authResults: 'mx.cloudflare.net; spf=none smtp.mailfrom=user@example.com; dmarc=none header.from=example.com',
      raw: rawWith(trustedAuth),
    });
    if (replyFails) (message.reply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not repliable'));
    return { done: handleFreeCheck(message, tenant, 'tok'), message, sent };
  }
  const raw = (m: ForwardableEmailMessage) => ((m.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { raw: string }).raw;

  it('Google MX and no SPF record: the emailed fix is the catalog\'s Google SPF record', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.searchParams.get('type') === 'MX' && u.searchParams.get('name') === 'example.com') {
        return { ok: true, json: () => Promise.resolve({ Status: 0, Answer: [{ type: 15, data: '1 aspmx.l.google.com.' }] }) } as unknown as Response;
      }
      return { ok: true, json: () => Promise.resolve({ Status: 3 }) } as unknown as Response;
    });
    // SPF did not pass on this message (no record), so the reply goes through reply(): the SEND_EMAIL fallback needs an SPF pass
    const { done, message } = run({}, false, 'spf=none smtp.mailfrom=user@example.com; dkim=pass header.d=example.com header.s=sel1; dmarc=none header.from=example.com');
    await done;
    expect(raw(message)).toContain('v=spf1 include:_spf.google.com ~all');
    expect(raw(message)).not.toMatch(/resolver|cross-check|consensus/i);
  });

  it('MAIL_REPLY_TO set: the reply carries that Reply-To, and so does the outbound fallback', async () => {
    mockDohEmpty();
    const a = run({ MAIL_REPLY_TO: 'hello@inboxangel.io' });
    await a.done;
    expect(raw(a.message)).toMatch(/^Reply-To: <?hello@inboxangel\.io>?\r?$/m);
    mockDohEmpty();
    const b = run({ MAIL_REPLY_TO: 'hello@inboxangel.io' }, true);
    await b.done;
    expect(b.sent[0].replyTo).toBe('hello@inboxangel.io');
  });

  it('MAIL_REPLY_TO unset: no Reply-To on either path', async () => {
    mockDohEmpty();
    const a = run({});
    await a.done;
    expect(raw(a.message)).not.toMatch(/^Reply-To:/im);
    mockDohEmpty();
    const b = run({}, true);
    await b.done;
    expect(b.sent[0].replyTo).toBeUndefined();
  });

  it('SITE_URL unset (even with BETTER_AUTH_URL set): no marketing link to the worker', async () => {
    mockDohEmpty();
    const b = run({ BETTER_AUTH_URL: 'https://app.worker.example' }, true);
    await b.done;
    expect(b.sent[0].text).not.toContain('app.worker.example');
    expect(b.sent[0].html).not.toContain('app.worker.example');
    expect(b.sent[0].text).not.toMatch(/https?:\/\//);
  });

  it('SITE_URL set: the marketing link points there', async () => {
    mockDohEmpty();
    const b = run({ SITE_URL: 'https://inboxangel.io/' }, true);
    await b.done;
    expect(b.sent[0].text).toContain('https://inboxangel.io');
    expect(b.sent[0].html).toContain('href="https://inboxangel.io"');
  });

  it('BOOKING_URL set: "or we do it for you" points there in both bodies', async () => {
    mockDohEmpty();
    const b = run({ BOOKING_URL: 'https://cal.example/max/30min', SITE_URL: 'https://inboxangel.io' }, true);
    await b.done;
    expect(b.sent[0].text).toContain('Or we do it for you: https://cal.example/max/30min');
    expect(b.sent[0].html).toContain('href="https://cal.example/max/30min"');
  });
});

describe('buildReplyRaw', () => {
  it('omits In-Reply-To when the original had no Message-ID', () => {
    const raw = buildReplyRaw({ name: 'InboxAngel', addr: 'check@reports.inboxangel.io' }, 'a@b.co', 'Hi', 'text', '<p>html</p>', null);
    expect(raw).not.toMatch(/In-Reply-To/i);
  });
});
