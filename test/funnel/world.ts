// Shared setup for the email-funnel tests.
import { vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import type { BoundEnv } from '../../src/index';
import type { Mailer, MailMessage, SendResult } from '../../src/mail/mailer';
import { enrollLead } from '../../src/funnel/enroll';
import type { CheckSummary } from '../../src/email/report-formatter';
import { HOSTED_ENV } from '../hosted/world';

export const T0 = 1_800_000_000;
export const DAY = 86400;

/** A hosted environment with everything the sequence needs. */
export const FUNNEL_ENV = {
  ...HOSTED_ENV,
  BETTER_AUTH_SECRET: 'test-secret-for-funnel',
  AUTHSERV_ID: 'mx.cloudflare.net',
  AUTHSERV_HEADER: 'ar',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'max@inboxangel.io',
  MAIL_REPLY_TO: 'max@inboxangel.io',
  PUBLIC_BASE_URL: 'https://app.inboxangel.io',
  POSTAL_ADDRESS: '1 Example Street\nWilmington, DE 19801, USA',
  BOOKING_URL: 'https://cal.example.com/max/30min',
  SERVICE_PRICES: JSON.stringify({ assessment: '$ASSESS', enforcement: '$ENFORCE', bimi: '$BIMI', retainer: '$RETAIN/mo' }),
} as const;

export const summary = (over: Partial<CheckSummary> = {}): CheckSummary => ({
  status: 'exposed', domain: 'acme.com', spfPass: true, dkimPass: true, dmarcPass: true, dmarcPolicy: 'none', dkimPresent: true, ...over,
});

/** A raw message whose header block starts with the given Authentication-Results headers (topmost first). */
export const rawWithAuth = (...authResults: string[]) => `${authResults.map(a => `Authentication-Results: ${a}`).join('\r\n')}${authResults.length ? '\r\n' : ''}Subject: hi\r\n\r\nhi`;

export function quietLogs() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

export interface FakeMailer extends Mailer { sent: MailMessage[]; next: SendResult[] }

/** A mailer that records what it is given. Push to `next` to make the following sends fail. */
export function fakeMailer(provider: Mailer['provider'] = 'resend', arbitraryRecipients = true): FakeMailer {
  const m: FakeMailer = {
    provider, arbitraryRecipients, sent: [], next: [],
    async send(msg) { m.sent.push(msg); return m.next.shift() ?? { ok: true, id: `id-${m.sent.length}` }; },
  };
  return m;
}

export function funnelWorld(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = { DB: db as unknown as D1Database, ...FUNNEL_ENV, ...extra } as unknown as BoundEnv;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const enroll = (email: string, over: Partial<CheckSummary> = {}, at = T0, domain = 'acme.com') => enrollLead(env, { email, domain, summary: summary({ domain, ...over }) }, at);
  return { db, env, rows, enroll, mailer: fakeMailer() };
}
