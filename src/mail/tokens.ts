// Signed, login-free tokens for links in email: unsubscribe and double opt-in confirmation.
//
// The payload (which holds the address) is encrypted, so the address is not readable in the URL, in request logs or in a
// forwarded email; the whole token is authenticated (encrypt-then-MAC):
//   token = base64url(iv ‖ AES-256-GCM(payload)) . base64url(HMAC-SHA256(ciphertext part))
// Both keys are derived from the instance's auth secret with purpose labels, so a session secret never signs these and
// these never validate as anything else. Unsubscribe tokens do not expire (a link in an old email must work);
// confirmation tokens carry `x`.

import { authSecret } from '../auth/secret';
import type { AuthEnv } from '../auth/config';

export type TokenPayload =
  | { p: 'unsub'; e: string }
  | { p: 'confirm'; e: string; w: string; s: number; x: number };

const enc = new TextEncoder();

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function derive(env: AuthEnv, label: string): Promise<ArrayBuffer> {
  const secret = await authSecret(env);
  const root = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', root, enc.encode(`inbox-angel:email-links:v2:${label}`));
}

const macKey = async (env: AuthEnv, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', await derive(env, 'mac'), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
const aesKey = async (env: AuthEnv) => crypto.subtle.importKey('raw', await derive(env, 'enc'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export async function signToken(env: AuthEnv, payload: TokenPayload): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(JSON.stringify(payload))));
  const body = b64(Uint8Array.from([...iv, ...ct]));
  const mac = await crypto.subtle.sign('HMAC', await macKey(env, 'sign'), enc.encode(body));
  return `${body}.${b64(new Uint8Array(mac))}`;
}

/** The payload if the token is authentic (and, for confirm tokens, not expired); null for anything else. */
export async function verifyToken(env: AuthEnv, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<TokenPayload | null> {
  const [body, sig, ...rest] = token.split('.');
  if (!body || !sig || rest.length) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await macKey(env, 'verify'), unb64(sig), enc.encode(body)))) return null;
    const raw = unb64(body);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(env), raw.slice(12));
    const p = JSON.parse(new TextDecoder().decode(plain)) as TokenPayload;
    if (p.p === 'unsub' && typeof p.e === 'string') return p;
    if (p.p === 'confirm' && typeof p.e === 'string' && typeof p.w === 'string' && typeof p.s === 'number' && typeof p.x === 'number' && p.x > nowSeconds) return p;
    return null;
  } catch {
    return null;
  }
}

/**
 * Keyed hash (HMAC-SHA256, truncated) of a value that must not be stored in a reversible form: an IP address or an email
 * in a rate-limit key. A plain hash of an IPv4 address or a guessable email can be reversed by enumeration; this cannot
 * without the secret. `purpose` separates the uses.
 */
export async function keyedHash(env: AuthEnv, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await derive(env, `hash:${purpose}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value.trim().toLowerCase())));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
