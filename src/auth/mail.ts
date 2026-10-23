// Password-reset email, over the same outbound path as every other InboxAngel email
// (the SEND_EMAIL Email Routing binding).
//
// Self-host limitation: Cloudflare Email Routing only delivers to destination addresses
// verified on the workspace, so a reset email reaches the owner (verified during setup) but
// not an arbitrary teammate. Without SEND_EMAIL the link is written to the Worker log.
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
    } catch (e) {
      console.error('[auth] reset email send failed:', e);
    }
  } else {
    console.log(`[auth] reset link for ${user.email}: ${resetUrl}`);
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
    } catch (e) {
      console.error('[auth] verification email send failed:', e);
    }
  } else {
    console.log(`[auth] verification link for ${user.email}: ${verifyUrl}`);
  }
}
