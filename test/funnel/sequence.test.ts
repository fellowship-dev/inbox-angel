import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runOnboardingSequence, readiness } from '../../src/funnel/sequence';
import { stepCopy } from '../../src/funnel/copy';
import { buildLetterText } from '../../src/email/html-templates';
import { stopLead, unsubscribeEmail } from '../../src/funnel/enroll';
import { SEQUENCE_DAYS } from '../../src/funnel/copy';
import { DAY, T0, fakeMailer, funnelWorld, quietLogs, summary } from './world';

beforeEach(quietLogs);
afterEach(() => vi.restoreAllMocks());

const run = (w: ReturnType<typeof funnelWorld>, at: number, mailer = w.mailer) => runOnboardingSequence(w.env, at, { mailer });

describe('step timing (fake clock)', () => {
  it('sends day 1, 3, 6, 10, 14 after enrolment, one email each, then completes', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    expect(w.rows('SELECT step, next_send_at FROM leads')).toEqual([{ step: 0, next_send_at: T0 + DAY }]);

    for (const [i, day] of SEQUENCE_DAYS.entries()) {
      expect((await run(w, T0 + day * DAY - 1)).sent).toBe(0); // one second early: nothing
      expect((await run(w, T0 + day * DAY)).sent).toBe(1);
      expect(w.mailer.sent).toHaveLength(i + 1);
    }
    expect(w.rows('SELECT status, step, next_send_at FROM leads')).toEqual([{ status: 'completed', step: 5, next_send_at: null }]);
    expect((await run(w, T0 + 60 * DAY)).sent).toBe(0);
    const subjects = w.mailer.sent.map(m => m.subject);
    expect(new Set(subjects).size).toBe(5);
    expect(subjects[0]).toContain('acme.com');
  });

  it('is idempotent: running again at the same time sends nothing more', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    await run(w, T0 + DAY);
    await run(w, T0 + DAY);
    await run(w, T0 + DAY + 10);
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('two overlapping runs cannot both send the same step (lease)', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    const [a, b] = await Promise.all([run(w, T0 + DAY), run(w, T0 + DAY)]);
    expect(a.sent + b.sent).toBe(1);
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('one step per lead per run, and a lead that is far behind catches up a day apart, never in a burst', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    const late = T0 + 30 * DAY;
    expect((await run(w, late)).sent).toBe(1);
    expect((await run(w, late)).sent).toBe(0);
    expect((await run(w, late + DAY - 60)).sent).toBe(1); // the next daily tick may fire a little earlier than yesterday's
    expect((await run(w, late + 2 * DAY - 120)).sent).toBe(1); // ... and still it is not a burst
    expect(w.mailer.sent.map(m => m.idempotencyKey)).toEqual([expect.stringMatching(/-step-0$/), expect.stringMatching(/-step-1$/), expect.stringMatching(/-step-2$/)]);
  });

  it('handles each lead independently', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com', {}, T0);
    await w.enroll('b@beta.com', {}, T0 + 2 * DAY, 'beta.com');
    expect((await run(w, T0 + DAY)).sent).toBe(1);
    expect((await run(w, T0 + 3 * DAY)).sent).toBe(2); // a step 2 (day 3), b step 1 (day 1+2)
  });
});

describe('stop conditions', () => {
  it('stops on unsubscribe: the lead is deleted and nothing is sent', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    await unsubscribeEmail(w.env, 'A@Acme.com');
    expect((await run(w, T0 + DAY)).sent).toBe(0);
    expect(w.rows('SELECT * FROM leads')).toEqual([]);
  });

  it('checks the suppression list before every send, even for a lead enrolled earlier', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    w.db.sqlite.prepare('INSERT INTO suppression (email_hash, reason) VALUES (?, ?)').run(await (await import('@inbox-angel/db')).hashEmail('a@acme.com'), 'complaint');
    const r = await run(w, T0 + DAY);
    expect(r).toMatchObject({ sent: 0, stopped: 1 });
    expect(w.mailer.sent).toEqual([]);
    expect(w.rows('SELECT * FROM leads')).toEqual([]);
  });

  it('stops on a bounce (recipient refused) and suppresses the address', async () => {
    const w = funnelWorld();
    await w.enroll('gone@acme.com');
    w.mailer.next.push({ ok: false, kind: 'recipient', error: 'mailbox does not exist' });
    expect(await run(w, T0 + DAY)).toMatchObject({ sent: 0, stopped: 1 });
    expect(w.rows('SELECT status FROM leads')).toEqual([{ status: 'bounced' }]);
    expect(w.rows('SELECT reason FROM suppression')).toEqual([{ reason: 'bounce' }]);
    expect((await run(w, T0 + 3 * DAY)).sent).toBe(0);
  });

  it('a transient failure may miss that one email but never repeats it, and stops the run', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    await w.enroll('b@beta.com', {}, T0, 'beta.com');
    w.mailer.next.push({ ok: false, kind: 'transient', error: 'timeout' });
    expect(await run(w, T0 + DAY)).toMatchObject({ sent: 0, failed: 1 });
    expect(w.mailer.sent).toHaveLength(1); // the run stopped; b was not tried
    expect(w.rows('SELECT email, step FROM leads ORDER BY id')).toEqual([{ email: 'a@acme.com', step: 1 }, { email: 'b@beta.com', step: 0 }]);
    expect((await run(w, T0 + DAY + 3601)).sent).toBe(1); // b goes out; a's step 0 is not resent
    expect(w.mailer.sent.map(m => m.to)).toEqual(['a@acme.com', 'b@beta.com']);
  });

  it('a crash after the step is marked sent (even after the provider took the mail) cannot send it twice', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    const crashing = fakeMailer();
    crashing.send = async (m) => { crashing.sent.push(m); throw new Error('worker killed'); };
    expect((await run(w, T0 + DAY, crashing)).failed).toBe(1);
    expect(w.rows('SELECT step FROM leads')).toEqual([{ step: 1 }]);
    expect((await run(w, T0 + 2 * DAY)).sent).toBe(0); // day 3 is not due; step 0 is not retried
    expect(crashing.sent.concat(w.mailer.sent)).toHaveLength(1);
  });

  it('a configuration failure puts the step back and stops the run before every lead loses its email', async () => {
    const w = funnelWorld();
    for (const e of ['a@a.com', 'b@b.com', 'c@c.com']) await w.enroll(e, {}, T0, e.split('@')[1]);
    w.mailer.next.push({ ok: false, kind: 'config', error: 'API key is invalid' });
    expect(await run(w, T0 + DAY)).toMatchObject({ sent: 0, failed: 1 });
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.rows('SELECT step, status, next_send_at FROM leads')).toEqual(Array(3).fill({ step: 0, status: 'active', next_send_at: T0 + DAY }));
    expect((await run(w, T0 + DAY + 60)).sent).toBe(3); // fixed: all three go out
  });

  it('stops once they buy: an account with the same email', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    w.db.sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a@acme.com', 'A')").run();
    expect(await run(w, T0 + DAY)).toMatchObject({ sent: 0, stopped: 1 });
    expect(w.rows('SELECT status FROM leads')).toEqual([{ status: 'converted' }]);
  });

  it.each(['replied', 'booked', 'converted'] as const)('stops when the owner records %s', async (reason) => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    const id = w.rows('SELECT id FROM leads')[0].id;
    expect(await stopLead(w.env, id, reason)).toBe(true);
    expect((await run(w, T0 + DAY)).sent).toBe(0);
    expect(w.rows('SELECT status FROM leads')).toEqual([{ status: reason }]);
    expect(await stopLead(w.env, 9999, reason)).toBe(false);
  });
});

describe('held steps', () => {
  it('leads waiting for BOOKING_URL do not starve the rest of the batch', async () => {
    const w = funnelWorld({ BOOKING_URL: undefined });
    for (const i of [1, 2, 3]) {
      await w.enroll(`held${i}@x${i}.com`, {}, T0, `x${i}.com`);
      w.db.sqlite.prepare('UPDATE leads SET step = 4, next_send_at = ? WHERE email = ?').run(T0 + i, `held${i}@x${i}.com`);
    }
    await w.enroll('fresh@fresh.com', {}, T0 + 10, 'fresh.com');
    w.db.sqlite.prepare("UPDATE leads SET next_send_at = ? WHERE email = 'fresh@fresh.com'").run(T0 + 100);
    const at = T0 + 20 * DAY;
    const small = (now: number) => runOnboardingSequence(w.env, now, { mailer: w.mailer, limit: 2 });
    expect(await small(at)).toMatchObject({ held: 2, sent: 0 });
    expect(await small(at)).toMatchObject({ held: 1, sent: 1 }); // the held ones moved a day out; fresh is reached
    expect(w.mailer.sent.map(m => m.to)).toEqual(['fresh@fresh.com']);
  });
});

describe('copy', () => {
  it('no draft note ever reaches a lead', async () => {
    const w = funnelWorld();
    for (const over of [{}, { dmarcPolicy: null }, { dmarcPolicy: 'reject' as const }]) {
      for (let i = 0; i < SEQUENCE_DAYS.length; i++) {
        const copy = stepCopy(i, { domain: 'acme.com', summary: summary(over), bookingUrl: 'https://cal.example.com', prices: {} });
        const text = copy.subject + buildLetterText(copy.blocks);
        expect(text, `step ${i}`).not.toMatch(/VERIFY|TODO|FIXME|XXX/);
      }
    }
    expect(w).toBeTruthy();
  });

  it('does not overpromise BIMI: Apple Mail needs a VMC, display is up to the mailbox provider', () => {
    const c = stepCopy(2, { domain: 'acme.com', summary: null, bookingUrl: null, prices: {} });
    const t = buildLetterText(c.blocks);
    expect(t).toMatch(/Apple Mail needs a VMC/);
    expect(t).toMatch(/mailbox provider's decision/);
    const d = buildLetterText(stepCopy(3, { domain: 'acme.com', summary: null, bookingUrl: null, prices: {} }).blocks);
    expect(d).toMatch(/can show where it is supported/);
    expect(d).not.toMatch(/shows in Gmail and Apple Mail/);
    const all = [0, 1, 2, 3, 4].map(i => buildLetterText(stepCopy(i, { domain: 'acme.com', summary: summary({ dmarcPolicy: 'none' }), bookingUrl: 'https://c.example', prices: {} }).blocks)).join('\n');
    expect(all).not.toMatch(/criminal|protects no one/i);
  });

  it('day 14 is from "Max at Inbox Angel" and signed that way', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    for (const d of SEQUENCE_DAYS) await run(w, T0 + d * DAY);
    expect(w.mailer.sent.map(m => m.from.name)).toEqual(['Inbox Angel', 'Inbox Angel', 'Inbox Angel', 'Inbox Angel', 'Max at Inbox Angel']);
    expect(w.mailer.sent[4].from.email).toBe('max@inboxangel.io');
    expect(w.mailer.sent[4].text).toMatch(/Max at Inbox Angel\n/);
  });
});

describe('provider and configuration', () => {
  it('with no provider the sequence queues and sends nothing, and says why', async () => {
    const w = funnelWorld({ RESEND_API_KEY: undefined });
    await w.enroll('a@acme.com');
    expect((await runOnboardingSequence(w.env, T0 + 20 * DAY)).sent).toBe(0);
    expect(w.rows('SELECT step, status FROM leads')).toEqual([{ step: 0, status: 'active' }]);
    expect(readiness(w.env).blockers.join(' ')).toMatch(/No mail provider/);
  });

  it('a send_email binding is never used for the sequence (Cloudflare Email Service is transactional-only)', async () => {
    const w = funnelWorld({ RESEND_API_KEY: undefined, SEND_EMAIL: { send: vi.fn() } });
    await w.enroll('a@acme.com');
    expect((await runOnboardingSequence(w.env, T0 + DAY)).sent).toBe(0);
    expect(readiness(w.env).blockers.join(' ')).toMatch(/RESEND_API_KEY/);
    expect((w.env.SEND_EMAIL as any).send).not.toHaveBeenCalled();
  });

  it('refuses to send without an unsubscribe link or postal address', async () => {
    for (const missing of ['PUBLIC_BASE_URL', 'POSTAL_ADDRESS']) {
      const w = funnelWorld({ [missing]: undefined });
      await w.enroll('a@acme.com');
      expect(readiness(w.env).blockers.join(' ')).toContain(missing);
      expect((await run(w, T0 + DAY)).sent).toBe(0);
    }
  });

  it('holds the day-14 note until BOOKING_URL is set, then sends it with the link', async () => {
    const w = funnelWorld({ BOOKING_URL: undefined });
    await w.enroll('a@acme.com');
    for (const d of SEQUENCE_DAYS.slice(0, 4)) await run(w, T0 + d * DAY);
    expect(w.mailer.sent).toHaveLength(4);
    expect((await run(w, T0 + 14 * DAY)).held).toBe(1);
    expect(w.mailer.sent).toHaveLength(4);
    const env2 = { ...w.env, BOOKING_URL: 'https://cal.example.com/max/30min' };
    expect((await runOnboardingSequence(env2, T0 + 15 * DAY, { mailer: w.mailer })).sent).toBe(1);
    expect(w.mailer.sent[4].text).toContain('https://cal.example.com/max/30min');
    expect(w.mailer.sent[4].html).toContain('https://cal.example.com/max/30min');
  });

  it('self-host: off unless ONBOARDING_SEQUENCE_ENABLED=1', async () => {
    const off = funnelWorld({ MODE: undefined, SAAS_ENABLED: undefined });
    expect(await off.enroll('a@acme.com')).toBe('disabled');
    expect(readiness(off.env).enabled).toBe(false);
    const on = funnelWorld({ MODE: undefined, SAAS_ENABLED: undefined, ONBOARDING_SEQUENCE_ENABLED: '1' });
    expect(await on.enroll('a@acme.com')).toBe('enrolled');
  });
});

describe('what goes out', () => {
  it('every email carries the unsubscribe link, one-click headers, the postal address and a suppression-checked recipient', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    await run(w, T0 + DAY);
    const m = w.mailer.sent[0];
    expect(m.to).toBe('a@acme.com');
    expect(m.from).toEqual({ name: 'Inbox Angel', email: 'max@inboxangel.io' });
    expect(m.replyTo).toBe('max@inboxangel.io');
    const link = m.headers!['List-Unsubscribe'].slice(1, -1);
    expect(link).toMatch(/^https:\/\/app\.inboxangel\.io\/api\/unsubscribe\?t=/);
    expect(m.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.text).toContain(`Unsubscribe: ${link}`);
    expect(m.text).toContain('1 Example Street, Wilmington, DE 19801, USA');
    expect(m.html).toContain('Wilmington');
    expect(m.html).toMatch(/<a href="[^"]+\/api\/unsubscribe\?t=[^"]+"[^>]*>Unsubscribe<\/a>/);
    expect(m.text).not.toMatch(/[\u{1F300}-\u{1FAFF}✅⚠]/u); // no emoji
  });

  it('day 1 is personalised from the stored check', async () => {
    const cases: [Parameters<ReturnType<typeof funnelWorld>['enroll']>[1], RegExp][] = [
      [{ dmarcPolicy: null, dmarcPass: false }, /no DMARC record/],
      [{ dmarcPolicy: 'none' }, /p=none/],
      [{ dmarcPolicy: 'reject', status: 'protected' }, /p=reject/],
      [{ dmarcPolicy: 'quarantine', status: 'at_risk' }, /quarantine/],
      [{ spfProblem: 'multiple SPF records' }, /multiple SPF records/],
      [{ dmarcPass: false, spfPass: false, dkimPass: false, dmarcPolicy: 'reject' }, /not properly authenticated/],
    ];
    for (const [over, re] of cases) {
      const w = funnelWorld();
      await w.enroll('a@acme.com', over);
      await run(w, T0 + DAY);
      expect(w.mailer.sent[0].text).toMatch(re);
    }
  });

  it('day 10 reads its "from" prices from config and has none when unset', async () => {
    const withPrices = funnelWorld();
    await withPrices.enroll('a@acme.com');
    for (const d of SEQUENCE_DAYS.slice(0, 4)) await run(withPrices, T0 + d * DAY);
    const t = withPrices.mailer.sent[3].text;
    for (const p of ['$ASSESS', '$ENFORCE', '$BIMI', '$RETAIN/mo']) expect(t).toContain(p);

    const none = funnelWorld({ SERVICE_PRICES: undefined });
    await none.enroll('a@acme.com');
    for (const d of SEQUENCE_DAYS.slice(0, 4)) await run(none, T0 + d * DAY);
    expect(none.mailer.sent[3].text).not.toMatch(/\$|Prices start/);
    expect(readiness(none.env).warnings.join(' ')).toMatch(/SERVICE_PRICES/);
  });

  it('works with a mailer built from the environment (Resend over HTTP, with an idempotency key)', async () => {
    const w = funnelWorld();
    await w.enroll('a@acme.com');
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await runOnboardingSequence(w.env, T0 + DAY)).sent).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^lead-\d+-step-0$/);
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['a@acme.com'], reply_to: 'max@inboxangel.io' });
    vi.unstubAllGlobals();
  });
});
