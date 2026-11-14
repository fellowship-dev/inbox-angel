// The hosted verification link: one link that confirms the address and chooses the password, in one step.
//
// The emailed link is `<origin>/#/welcome/<token>`: the token sits in the URL fragment, which browsers never send to a server,
// so it is not in any request line, log or Referer. Opening the link changes nothing (a mail scanner or link-preview bot that
// fetches it gets the dashboard's page and nothing else), so the person's own click still works, from any device, any number
// of times, until the token's lifetime ends (VERIFICATION_LINK_SECONDS, the one number the mail and the pages state).
//
// Everything happens on the welcome page's POST (token + new password), atomically: the address is marked verified and the
// chosen password replaces whatever was there (a password someone set when they registered the address is gone), every
// session of the account ends, then the person is signed in. Once the account is verified with a password chosen this way,
// the token is refused ("already used"): it can set a password once.
import { verifyJWT } from 'better-auth/crypto';
import { globalQueries } from '@ready-set-mail/db';
import { hashPassword } from '../api/password';
import type { AuthEnv } from './config';
import { d1RateLimitStorage } from './rate-limit';
import { authSecret } from './secret';

/** How long a verification link works. The emailed text and the pages state this same number. */
export const VERIFICATION_LINK_SECONDS = 24 * 3600;
export const VERIFICATION_LINK_HOURS = VERIFICATION_LINK_SECONDS / 3600;

/** The emailed link: the token in the fragment, never in a request line. */
export const welcomeLink = (origin: string, token: string): string => `${origin}/#/welcome/${encodeURIComponent(token)}`;

export type WelcomeRefusal = 'link_invalid' | 'link_expired' | 'link_used';

/** The address a verification token was issued for, or why it cannot be used. Better Auth signs these tokens (HS256, its secret). */
export async function readVerificationToken(env: AuthEnv, token: string): Promise<{ email: string } | { refused: Exclude<WelcomeRefusal, 'link_used'> }> {
  const payload = (await verifyJWT(token, await authSecret(env))) as { email?: unknown; updateTo?: unknown } | null;
  if (!payload) return { refused: unverifiedExpiry(token) ? 'link_expired' : 'link_invalid' };
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  // A change-of-address token (updateTo) is not a sign-up link.
  if (!email || payload.updateTo) return { refused: 'link_invalid' };
  return { email };
}

/** Only to word the refusal: did a token that failed verification carry an expiry in the past? It grants nothing either way. */
function unverifiedExpiry(token: string): boolean {
  try {
    const part = token.split('.')[1] ?? '';
    const exp = (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown }).exp;
    return typeof exp === 'number' && exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');

/** Attempts per token (10 an hour) and per IP (30 an hour), counted in D1 so every isolate agrees. */
export async function welcomeAttemptAllowed(env: AuthEnv, token: string, ip: string): Promise<boolean> {
  const limiter = d1RateLimitStorage(env.DB as D1Database);
  const perToken = await limiter.consume(`welcome:token:${(await sha256Hex(token)).slice(0, 40)}`, { window: 3600, max: 10 });
  const perIp = await limiter.consume(`welcome:ip:${ip}`, { window: 3600, max: 30 });
  return perToken.allowed && perIp.allowed;
}

/**
 * Verify the address and set the password in one transaction. Wins only when the account is not yet verified (or was verified
 * by the earlier link design and never got a password, stored as '!'); two simultaneous posts of one token: exactly one wins.
 * On a win every session of the account ends. Returns the user id, or the refusal.
 */
export async function completeWelcome(env: AuthEnv, email: string, password: string): Promise<{ userId: string } | { refused: WelcomeRefusal }> {
  const db = env.DB as D1Database;
  const user = await globalQueries(db).users.byEmail(email);
  if (!user) return { refused: 'link_invalid' };
  const hash = await hashPassword(password);
  let won = false;
  if (!user.email_verified) {
    const [, verified] = await db.batch([
      db.prepare("UPDATE auth_accounts SET password = ?1 WHERE user_id = ?2 AND provider_id = 'credential' AND (SELECT email_verified FROM users WHERE id = ?2) = 0").bind(hash, user.id),
      db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?1 AND email_verified = 0 AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?1 AND provider_id = 'credential' AND password = ?2)").bind(user.id, hash),
    ]);
    won = (verified?.meta.changes ?? 0) === 1;
  } else {
    const r = await db.prepare("UPDATE auth_accounts SET password = ?1 WHERE user_id = ?2 AND provider_id = 'credential' AND password = '!'").bind(hash, user.id).run();
    won = (r.meta.changes ?? 0) === 1;
  }
  if (!won) return { refused: 'link_used' };
  await globalQueries(db).sessions.revokeAll(user.id);
  return { userId: user.id };
}

/**
 * Links sent before the fragment design pointed at GET /api/auth/verify-email?token=…. That request changes nothing: it answers
 * a page whose script moves the token into the fragment of the welcome page (no Location header carries it), with no Referer.
 */
const LEGACY_SCRIPT = "var t=new URLSearchParams(location.search).get('token')||'';location.replace('/#/welcome/'+encodeURIComponent(t));";
export async function legacyVerifyLinkPage(): Promise<Response> {
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(LEGACY_SCRIPT)))));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Ready Set Mail</title></head><body><script>${LEGACY_SCRIPT}</script><noscript><p>Open this link in a browser with JavaScript on to choose your Ready Set Mail password.</p></noscript></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** A short key for an address (FNV-1a, two lanes): the rate-limit table never holds the address itself. Synchronous on purpose:
 *  the cap runs inside the mail callback, before the send. */
function addressKey(email: string): string {
  const s = email.toLowerCase().trim();
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Per-address cap on verification mail, counted across every route that sends one (sign-up, resend, a sign-in of an unverified
 * account, a hosted invitee): 3 an hour and 10 a day. Over the cap the mail is simply not sent; the routes answer exactly as
 * before, so nothing reveals whether the address exists. Keys hold a hash, never the address.
 */
export async function verificationMailAllowed(env: AuthEnv, email: string): Promise<boolean> {
  const limiter = d1RateLimitStorage(env.DB as D1Database);
  const k = addressKey(email);
  const hour = await limiter.consume(`verify-mail:h:${k}`, { window: 3600, max: 3 });
  if (!hour.allowed) return false;
  const day = await limiter.consume(`verify-mail:d:${k}`, { window: 86400, max: 10 });
  return day.allowed;
}
