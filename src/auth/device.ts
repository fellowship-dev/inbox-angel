// A device that has signed in to an account before: a signed, long-lived, HttpOnly cookie bound to that account.
//
// The per-address sign-in throttle (welcome.ts) lets a stranger who keeps guessing an address make its owner wait. A request
// carrying a valid device cookie for that same account skips that per-address lock (the per-IP limits still apply), so the
// owner can always sign in from a device they used before. The cookie proves nothing else and opens no session.
import { authSecret } from './secret';
import type { AuthEnv } from './config';

export const DEVICE_COOKIE = 'rsm_device';
const DEVICE_SECONDS = 180 * 24 * 3600;

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(env: AuthEnv, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`device-cookie:${await authSecret(env)}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

/** The Set-Cookie value for this account on this device. */
export async function deviceCookie(env: AuthEnv, userId: string, secure: boolean, now = Date.now()): Promise<string> {
  const payload = `${userId}.${Math.floor(now / 1000) + DEVICE_SECONDS}`;
  return `${DEVICE_COOKIE}=${payload}.${await sign(env, payload)}; Path=/api/auth; Max-Age=${DEVICE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Does the request carry a valid, unexpired device cookie for this account? */
export async function knownDevice(env: AuthEnv, request: Request, userId: string, now = Date.now()): Promise<boolean> {
  const raw = (request.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1);
  if (!raw) return false;
  const [uid, exp, mac] = raw.split('.');
  if (!uid || !exp || !mac || uid !== userId || Number(exp) * 1000 < now) return false;
  const expected = await sign(env, `${uid}.${exp}`);
  if (expected.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
