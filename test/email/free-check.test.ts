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
}>= {}): ForwardableEmailMessage {
  const authHeader = overrides.authResults ?? [
    'mx.google.com;',
    ' dkim=pass header.d=example.com header.s=selector1;',
    ' spf=pass smtp.mailfrom=user@example.com;',
    ' dmarc=pass (p=reject dis=none) header.from=example.com',
  ].join('');

  const headers = new Headers({ 'authentication-results': authHeader, 'message-id': '<orig-123@mail.example.com>' });

  return {
    from: overrides.from ?? 'user@example.com',
    to: overrides.to ?? 'check@reports.inboxangel.io',
    headers,
    reply: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

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

describe('buildReplyRaw', () => {
  it('omits In-Reply-To when the original had no Message-ID', () => {
    const raw = buildReplyRaw({ name: 'InboxAngel', addr: 'check@reports.inboxangel.io' }, 'a@b.co', 'Hi', 'text', '<p>html</p>', null);
    expect(raw).not.toMatch(/In-Reply-To/i);
  });
});
