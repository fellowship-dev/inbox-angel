// Intake and canary tokens.
//
// A token is 160 random bits as 32 lowercase base32 characters (a-z, 2-7): it survives
// case-folding by mail systems and is valid in the local part after `+`. Only the SHA-256
// of a token is stored; a token is high-entropy, so a plain hash is enough.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const TOKEN_LENGTH = 32;
const TOKEN_RE = new RegExp(`^[a-z2-7]{${TOKEN_LENGTH}}$`);

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function isTokenShaped(token: string): boolean {
  return TOKEN_RE.test(token);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.toLowerCase()));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Opaque id for a hosted domain: 80 bits, never derived from the customer's domain. */
export function generateHostedId(): string {
  return generateToken().slice(0, 16);
}

export type ReportKind = 'rua' | 'tls-rpt';

export function intakeAddress(kind: ReportKind, token: string, intakeDomain: string): string {
  return `${kind}+${token}@${intakeDomain}`;
}

export interface ParsedRecipient {
  /** The part before `+` (or the whole local part). */
  base: string;
  /** The part after the first `+`, if any. */
  tag?: string;
  host: string;
}

export function parseRecipient(to: string): ParsedRecipient | null {
  const at = to.lastIndexOf('@');
  if (at <= 0 || at === to.length - 1) return null;
  const local = to.slice(0, at).toLowerCase();
  const host = to.slice(at + 1).toLowerCase();
  const plus = local.indexOf('+');
  return plus < 0 ? { base: local, host } : { base: local.slice(0, plus), tag: local.slice(plus + 1), host };
}

export const HOSTED_ID_LENGTH = 16;

export function isHostedIdShaped(id: string): boolean {
  return /^[a-z2-7]{16}$/.test(id);
}
