// Password-reset and verification emails, over the same outbound path as every other InboxAngel email
// (the SEND_EMAIL Email Routing binding).
//
// Self-host limitation: Cloudflare Email Routing only delivers to destination addresses
// verified on the workspace, so a reset email reaches the owner (verified during setup) but
// not an arbitrary teammate. Without SEND_EMAIL (or a sender address) nothing is sent and the Worker log
// records only a static reason: for reset and verification the link, the recipient and provider errors
// can carry credentials, so they are never logged.
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@inbox-angel/db';
import type { AuthEnv } from './config';

/** The platform's sender: the implicit workspace's from_email (set by the setup wizard), else derived from its base domain. */
async function senderAddress(env: AuthEnv): Promise<string | undefined> {
  const q = forWorkspace(env.DB as D1Database, IMPLICIT_WORKSPACE_ID).settings;
  const s = await q.getMany(['from_email', 'base_domain']);
  return s.get('from_email') || (s.get('base_domain') ? `noreply@reports.${s.get('base_domain')}` : undefined);
}

export async function sendPasswordResetEmail(
  env: AuthEnv,
  user: { email: string; name: string },
  resetUrl: string,
): Promise<void> {
  const text = `Hi,\n\nYou requested a password reset for your InboxAngel account.\n\nClick the link below to set a new password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email — your password won't change.\n\nInboxAngel`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    try {
      await env.SEND_EMAIL.send({ from: { name: 'InboxAngel', email: from }, to: [user.email], subject: 'Reset your InboxAngel password', text });
    } catch {
      console.error('[auth] reset email send failed (provider error not logged)');
    }
  } else {
    unsent('reset', env);
  }
}

export async function sendVerificationEmail(
  env: AuthEnv,
  user: { email: string; name: string },
  verifyUrl: string,
): Promise<void> {
  const text = `Hi,\n\nConfirm your email address to finish setting up your InboxAngel account (you will choose your password on the next page):\n${verifyUrl}\n\nThe link expires in 24 hours. If you didn't sign up, ignore this email.\n\nInboxAngel`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    try {
      await env.SEND_EMAIL.send({ from: { name: 'InboxAngel', email: from }, to: [user.email], subject: 'Confirm your InboxAngel email', text });
    } catch {
      console.error('[auth] verification email send failed (provider error not logged)');
    }
  } else {
    unsent('verification', env);
  }
}

/** Static diagnostic for an email that could not be sent: names the operation and the missing piece, never the link, recipient or provider error. */
function unsent(operation: string, env: AuthEnv): void {
  const reason = !env.SEND_EMAIL ? 'SEND_EMAIL binding not configured' : 'no sender address (set from_email or base_domain)';
  console.warn(`[auth] ${operation} email not sent: ${reason}`);
}

/** Tells a workspace's owners that a domain was taken from it because another workspace proved it controls the domain. */
export async function sendEvictionNotice(env: AuthEnv, to: string[], domain: string, keepDays: number): Promise<void> {
  if (to.length === 0) return;
  const text = `Hi,\n\n${domain} was registered in your InboxAngel workspace before domain ownership was verified. Another workspace has now proven that it controls ${domain} (by a DNS record or through its Cloudflare zone), so ${domain} has been removed from yours: monitoring, hosted records and alerts for it have stopped.\n\nYour report history for ${domain} stays available to export for ${keepDays} days, then it is deleted.\n\nIf ${domain} really is yours, add it again and publish the TXT record InboxAngel shows you at _inboxangel.${domain}; if you believe this is a mistake, reply to this email.\n\nInboxAngel`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    for (const address of to) {
      try {
        await env.SEND_EMAIL.send({ from: { name: 'InboxAngel', email: from }, to: [address], subject: `${domain} was removed from your InboxAngel workspace`, text });
      } catch (e) {
        console.error('[auth] eviction notice send failed:', e);
      }
    }
  } else {
    console.log(`[auth] eviction notice for ${domain} to ${to.join(', ')}`);
  }
}
