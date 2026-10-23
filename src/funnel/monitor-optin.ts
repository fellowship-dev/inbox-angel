// POST /api/monitor with double opt-in. The visitor gives an address; we send one confirmation email and the
// subscription only starts alerting once its link is clicked (GET /api/monitor/confirm). Unconfirmed rows are
// deleted after 7 days (src/funnel/cron.ts).

import { forWorkspace, funnelQueries, globalQueries } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import type { TenantContext } from '../tenancy/context';
import { isSuppressed } from '../mail/compliance';
import { transactionalMailer } from '../mail/mailer';
import { keyedHash, signToken } from '../mail/tokens';
import { funnelSender, publicBaseUrl } from './config';
import { MONITOR_CONFIRM_WINDOW_SECONDS } from './cron';
import { normaliseEmail } from './enroll';

/** Confirmation emails one address may be sent per day, however many domains or sessions ask. */
export const CONFIRMATIONS_PER_ADDRESS_PER_DAY = 3;
/** Confirmation emails one free-check session (its token) may cause in total, over a week: it is one check, not a mailing tool. */
export const CONFIRMATIONS_PER_SESSION = 3;
/** Confirmation emails one client IP may cause per hour. */
export const CONFIRMATIONS_PER_IP_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type MonitorOptIn =
  | { status: 202; body: { domain: string; email: string; status: 'pending_confirmation' } }
  | { status: 429 | 502 | 503; body: { error: string } };

export async function requestMonitorSubscription(
  env: BoundEnv,
  tenant: TenantContext,
  input: { email: string; domain: string; sessionToken: string; clientIp: string; baseline: Omit<Parameters<TenantContext['scope']['monitor']['insert']>[0], 'email' | 'domain' | 'session_token' | 'confirmed_at'> },
  origin: string,
  now = Math.floor(Date.now() / 1000),
): Promise<MonitorOptIn> {
  const email = normaliseEmail(input.email);
  const accepted: MonitorOptIn = { status: 202, body: { domain: input.domain, email, status: 'pending_confirmation' } };

  // Transactional: the binding from the workspace's own sender, else Resend from MAIL_FROM (the only sender verified there).
  const mailer = transactionalMailer(env);
  const from = mailer?.provider === 'resend' ? funnelSender(env) : tenant.settings.fromEmail ? { name: 'InboxAngel', email: tenant.settings.fromEmail } : funnelSender(env);
  if (!mailer || !from) return { status: 503, body: { error: 'Email delivery is not configured on this server, so a confirmation cannot be sent' } };

  // A suppressed address (unsubscribed, bounced) gets nothing; the answer is the same as for any other address.
  if (await isSuppressed(env, email)) return accepted;

  const existing = await tenant.scope.monitor.byEmailDomain(email, input.domain);
  if (existing?.confirmed_at) return accepted; // already subscribed: nothing to confirm, nothing to send

  // Caps on how many emails one request source can cause, so this cannot be used to mail strangers: per client IP, per
  // check session (one free check is not a licence to mail a list), and per target address. Keys are keyed hashes.
  const limits = globalQueries(env.DB).rateLimit;
  const ms = now * 1000;
  if ((await limits.hit(`monitor-ip:${await keyedHash(env, 'ip', input.clientIp)}`, ms, HOUR_MS)).count > CONFIRMATIONS_PER_IP_PER_HOUR) {
    return { status: 429, body: { error: 'too many requests from this address, try again later' } };
  }
  if ((await limits.hit(`monitor-session:${await keyedHash(env, 'session', input.sessionToken)}`, ms, 7 * DAY_MS)).count > CONFIRMATIONS_PER_SESSION) {
    return { status: 429, body: { error: 'this email check has used up its confirmation emails' } };
  }
  if ((await limits.hit(`monitor-confirm:${await keyedHash(env, 'email', email)}`, ms, DAY_MS)).count > CONFIRMATIONS_PER_ADDRESS_PER_DAY) {
    // Same answer as any other request, no email: the person typing their own address must not be told they are blocked.
    console.warn('[monitor] confirmation not sent: per-address daily cap reached');
    return accepted;
  }

  if (!existing) await tenant.scope.monitor.insert({ ...input.baseline, email, domain: input.domain, session_token: input.sessionToken, confirmed_at: null });
  const row = existing ?? (await tenant.scope.monitor.byEmailDomain(email, input.domain));
  if (!row) return { status: 502, body: { error: 'could not create the subscription' } };

  const token = await signToken(env, { p: 'confirm', e: email, w: tenant.workspaceId, s: row.id, x: now + MONITOR_CONFIRM_WINDOW_SECONDS });
  const link = `${publicBaseUrl(env) ?? origin}/api/monitor/confirm?t=${encodeURIComponent(token)}`;
  const out = await mailer.send({
    from,
    to: email,
    subject: `Confirm email alerts for ${input.domain}`,
    text: [
      `Someone, probably you, asked InboxAngel to email ${email} when the email security settings of ${input.domain} change.`,
      '',
      'To start these alerts, confirm with this link (valid for 7 days):',
      link,
      '',
      "If you didn't ask for this, ignore this email: nothing will be sent and the request is deleted automatically.",
    ].join('\n'),
    idempotencyKey: `monitor-confirm-${row.id}-${Math.floor(now / 3600)}`,
  });
  if (out.ok) return accepted;
  // The bare send_email binding refuses addresses nobody verified: say so, or the visitor waits for mail that never comes.
  // (Any other provider's refusal looks like an invalid address and gets the same answer as everyone.)
  if (out.kind === 'recipient' && mailer.provider === 'binding') return { status: 502, body: { error: 'this server cannot send a confirmation to that address' } };
  if (out.kind === 'recipient') return accepted;
  console.error(`[monitor] confirmation not sent (${out.kind}): ${out.error}`);
  return { status: 502, body: { error: 'could not send the confirmation email, try again later' } };
}

/** Activate the subscription a confirmation link points at. False if the link is stale (the row expired or was removed). */
export async function confirmMonitorSubscription(env: BoundEnv, p: { w: string; s: number; e: string }, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (await funnelQueries(env.DB).suppression.has(p.e)) return false;
  return forWorkspace(env.DB, p.w).monitor.confirm(p.s, p.e, now);
}
