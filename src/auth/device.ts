// A device that has signed in to an account before: a signed, long-lived, HttpOnly cookie bound to that account.
//
// The per-address sign-in throttle (welcome.ts) lets a stranger who keeps guessing an address make its owner wait. A request
// carrying a valid device cookie for that same account skips that per-address lock (the per-IP limits still apply), so the
// owner can always sign in from a device they used before. The cookie proves nothing else and opens no session. It stops
// helping after a password change or reset, or "sign out everywhere" (accountMarker).
import { authSecret } from './secret';
import type { AuthEnv } from './config';

export const DEVICE_COOKIE = 'rsm_device';
const DEVICE_SECONDS = 180 * 24 * 3600;

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(env: AuthEnv, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`device-cookie:${await authSecret(env)}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

/** Where the account's device epoch lives: a row in the existing verifications table (no migration). */
const epochIdentifier = (userId: string) => `device-epoch:${userId}`;

/**
 * What a device cookie is bound to besides the account: a short hash of the account's current password hash and of its
 * device epoch. A password change or reset changes the first, "sign out everywhere" (and an OAuth link, which ends every
 * session) rotates the second, so any cookie issued before stops helping.
 */
export async function accountMarker(env: AuthEnv, userId: string): Promise<string> {
  const db = env.DB as D1Database;
  const pw = await db.prepare("SELECT password FROM auth_accounts WHERE user_id = ?1 AND provider_id = 'credential'").bind(userId).first<{ password: string | null }>();
  const epoch = await db.prepare('SELECT value FROM verifications WHERE identifier = ?1 ORDER BY created_at DESC LIMIT 1').bind(epochIdentifier(userId)).first<{ value: string }>();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${pw?.password ?? ''}|${epoch?.value ?? ''}`));
  return b64url(digest).slice(0, 16);
}

/** Start a new device epoch for the account: every device cookie issued so far stops skipping the per-address lock. */
export async function rotateDeviceEpoch(env: AuthEnv, userId: string): Promise<void> {
  const db = env.DB as D1Database;
  const value = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  await db.batch([
    db.prepare('DELETE FROM verifications WHERE identifier = ?1').bind(epochIdentifier(userId)),
    db.prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(crypto.randomUUID(), epochIdentifier(userId), value, Math.floor(Date.now() / 1000) + 20 * 365 * 86400),
  ]);
}

/** The Set-Cookie value for this account on this device. */
export async function deviceCookie(env: AuthEnv, userId: string, secure: boolean, now = Date.now()): Promise<string> {
  const payload = `${userId}.${Math.floor(now / 1000) + DEVICE_SECONDS}.${await accountMarker(env, userId)}`;
  return `${DEVICE_COOKIE}=${payload}.${await sign(env, payload)}; Path=/api/auth; Max-Age=${DEVICE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Does the request carry a valid, unexpired device cookie for this account? */
export async function knownDevice(env: AuthEnv, request: Request, userId: string, now = Date.now()): Promise<boolean> {
  const raw = (request.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1);
  if (!raw) return false;
  // userId.expiry.marker.mac; a cookie in the earlier three-part format no longer helps.
  const parts = raw.split('.');
  if (parts.length !== 4) return false;
  const [uid, exp, marker, mac] = parts as [string, string, string, string];
  if (uid !== userId || Number(exp) * 1000 < now) return false;
  if (marker !== (await accountMarker(env, userId))) return false; // password changed, or signed out everywhere, since
  const expected = await sign(env, `${uid}.${exp}.${marker}`);
  if (expected.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
