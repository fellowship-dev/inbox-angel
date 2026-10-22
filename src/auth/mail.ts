// Password-reset email, over the same outbound path as every other InboxAngel email
// (the SEND_EMAIL Email Routing binding).
//
// Self-host limitation: Cloudflare Email Routing only delivers to destination addresses
// verified on the account, so a reset email reaches the owner (verified during setup) but
// not an arbitrary teammate. Without SEND_EMAIL the link is written to the Worker log.
import { forAccount, IMPLICIT_ACCOUNT_ID } from '@inbox-angel/db';
import type { AuthEnv } from './config';

/** The platform's sender: the implicit account's from_email (set by the setup wizard), else derived from its base domain. */
async function senderAddress(env: AuthEnv): Promise<string | undefined> {
  const q = forAccount(env.DB as D1Database, IMPLICIT_ACCOUNT_ID).settings;
  const s = await q.getMany(['from_email', 'base_domain']);
  return s.get('from_email') || (s.get('base_domain') ? `noreply@reports.${s.get('base_domain')}` : undefined);
}

export async function sendPasswordResetEmail(
  env: AuthEnv,
  user: { email: string; name: string },
  resetUrl: string,
): Promise<void> {
  const text = `Hi ${user.name},\n\nYou requested a password reset for your InboxAngel account.\n\nClick the link below to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email — your password won't change.\n\nInboxAngel`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    try {
      await env.SEND_EMAIL.send({ from: { name: 'InboxAngel', email: from }, to: [user.email], subject: 'Reset your InboxAngel password', text });
    } catch (e) {
      console.error('[auth] reset email send failed:', e);
    }
  } else {
    console.log(`[auth] reset link for ${user.email}: ${resetUrl}`);
  }
}
