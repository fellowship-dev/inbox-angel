// What every non-transactional email (onboarding sequence, change alerts, weekly digests) goes through:
//   - a suppression check before the send,
//   - a one-click unsubscribe link (signed token, no login) in the body and in List-Unsubscribe / List-Unsubscribe-Post,
//   - the postal address (POSTAL_ADDRESS) in the footer.
// Transactional mail (password reset, invites, the confirmation link itself) does not use this.

import { funnelQueries } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import { hostedEnabled } from '../hosted/config';
import { postalAddress, publicBaseUrl } from '../funnel/config';
import type { Mailer, MailMessage, SendResult } from './mailer';
import { signToken } from './tokens';

export type NonTransactionalResult = SendResult | { ok: false; kind: 'suppressed' | 'blocked'; error: string };

export async function isSuppressed(env: Pick<BoundEnv, 'DB'>, email: string): Promise<boolean> {
  return funnelQueries(env.DB).suppression.has(email);
}

export async function unsubscribeUrl(env: BoundEnv, email: string): Promise<string | null> {
  const base = publicBaseUrl(env);
  if (!base) return null;
  return `${base}/api/unsubscribe?t=${encodeURIComponent(await signToken(env, { p: 'unsub', e: email.trim().toLowerCase() }))}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function footerText(unsubscribe: string | null, address: string | null): string {
  const lines = ['', '--', address ? `Inbox Angel, ${address.replace(/\s*\n\s*/g, ', ')}` : 'Inbox Angel'];
  if (unsubscribe) lines.push(`Unsubscribe: ${unsubscribe}`);
  return lines.join('\n');
}

export function footerHtml(unsubscribe: string | null, address: string | null): string {
  const parts = [`Inbox Angel${address ? `, ${esc(address).replace(/\s*\n\s*/g, ', ')}` : ''}`];
  if (unsubscribe) parts.push(`<a href="${esc(unsubscribe)}" style="color:#6b7280;">Unsubscribe</a>`);
  return `<div style="max-width:600px;margin:0 auto;padding:12px 24px 24px;font-family:Arial,sans-serif;font-size:11px;color:#6b7280;text-align:center;">${parts.join(' &middot; ')}</div>`;
}

/**
 * Send one non-transactional email. Never throws.
 *
 * `requireLink` (default: on for the hosted service): refuse to send when no unsubscribe link can be built because
 * PUBLIC_BASE_URL is unset. Self-host alerts to the instance's own team may go out without a link; they are still
 * suppression-checked and carry the footer.
 */
export async function sendNonTransactional(
  env: BoundEnv,
  mailer: Mailer,
  m: Omit<MailMessage, 'headers'> & { headers?: Record<string, string> },
  opts: { requireLink?: boolean } = {},
): Promise<NonTransactionalResult> {
  const to = m.to.trim().toLowerCase();
  try {
    if (await isSuppressed(env, to)) return { ok: false, kind: 'suppressed', error: 'recipient is on the suppression list' };
    const link = await unsubscribeUrl(env, to);
    if (!link && (opts.requireLink ?? hostedEnabled(env))) return { ok: false, kind: 'blocked', error: 'no unsubscribe link: PUBLIC_BASE_URL is not set' };
    const address = postalAddress(env);
    return await mailer.send({
      ...m,
      to,
      text: m.text + footerText(link, address),
      html: m.html ? m.html.replace(/<\/body>/i, `${footerHtml(link, address)}</body>`) : undefined,
      headers: {
        ...m.headers,
        ...(link ? { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
      },
    });
  } catch (e) {
    return { ok: false, kind: 'transient', error: e instanceof Error ? e.message : 'send failed' };
  }
}
