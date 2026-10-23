// Token encryption for Cloudflare connections.
//
// A connection's tokens (access, refresh, expiry) are sealed into one envelope string with AES-256-GCM
// (WebCrypto) under the Worker secret TOKEN_ENCRYPTION_KEY, and only the envelope is stored.
//
//   envelope = ia1.<key id>.<iv, base64url>.<ciphertext+tag, base64url>
//
// * The key id says which key sealed it, so keys rotate: put the new key first in TOKEN_ENCRYPTION_KEY
//   (`k2:<base64>,k1:<base64>`); every listed key still opens, new envelopes use the first, and an envelope
//   sealed under an older key is re-sealed the next time it is used (isCurrent / reseal). With more than one key
//   every key must carry its id: a lone bare key means "k1", and ids are never taken from position.
// * The additional authenticated data binds an envelope to its row (`<workspace>|<connection>`), so a
//   ciphertext copied onto another connection or workspace does not open.
// * Opened tokens live in a TokenMaterial, which refuses to serialize or inspect: the plaintext never
//   reaches logs, JSON or error messages. Errors here never contain it either.
//
// TOKEN_ENCRYPTION_KEY is 32 random bytes, base64: `openssl rand -base64 32`.

export interface CryptoEnv { TOKEN_ENCRYPTION_KEY?: string }

/** TOKEN_ENCRYPTION_KEY is missing or malformed: connections cannot be stored or opened. */
export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenKeyError';
  }
}

/** An envelope that does not open: tampered, bound to another row, sealed under a key that is no longer configured. */
export class TokenEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenEnvelopeError';
  }
}

const VERSION = 'ia1';
const DEFAULT_KID = 'k1';
const KID = /^[A-Za-z0-9_-]{1,32}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/** Decrypted token material. Refuses JSON and inspect output; read it with access() / refresh(). */
export class TokenMaterial {
  readonly #access: string;
  readonly #refresh?: string;
  /** Unix seconds at which the access token expires, if known. */
  readonly expiresAt?: number;

  constructor(parts: { access: string; refresh?: string; expiresAt?: number }) {
    this.#access = parts.access;
    this.#refresh = parts.refresh || undefined;
    this.expiresAt = parts.expiresAt;
  }

  access(): string { return this.#access; }
  refresh(): string | undefined { return this.#refresh; }

  expired(nowSeconds: number, skewSeconds = 60): boolean {
    return this.expiresAt !== undefined && this.expiresAt - skewSeconds <= nowSeconds;
  }

  toJSON(): { redacted: true } { return { redacted: true }; }
  toString(): string { return 'TokenMaterial [redacted]'; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return 'TokenMaterial { [redacted] }'; }
}

interface ParsedKey { kid: string; raw: Uint8Array }

function parseKeys(env: CryptoEnv): ParsedKey[] {
  const spec = env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!spec) throw new TokenKeyError('TOKEN_ENCRYPTION_KEY is not set: Cloudflare connections cannot be stored (generate one with `openssl rand -base64 32`)');
  const keys: ParsedKey[] = [];
  const entries = spec.split(',').map(e => e.trim()).filter(Boolean);
  // A position is not an identity: reordering keys on rotation would silently re-label them and make every envelope unreadable.
  if (entries.length > 1 && entries.some(e => e.indexOf(':') <= 0)) {
    throw new TokenKeyError('TOKEN_ENCRYPTION_KEY: with more than one key every key needs an explicit id, e.g. "k2:<base64>,k1:<base64>" (a key without an id is only accepted when it is the only one, and then means "k1")');
  }
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const kid = colon > 0 ? entry.slice(0, colon) : DEFAULT_KID;
    const b64 = colon > 0 ? entry.slice(colon + 1) : entry;
    if (!KID.test(kid)) throw new TokenKeyError('TOKEN_ENCRYPTION_KEY: invalid key id');
    let raw: Uint8Array;
    try { raw = unb64url(b64.replace(/=+$/, '')); } catch { throw new TokenKeyError('TOKEN_ENCRYPTION_KEY: key is not base64'); }
    if (raw.length !== 32) throw new TokenKeyError('TOKEN_ENCRYPTION_KEY: each key must be 32 bytes (base64 of 32 random bytes)');
    if (keys.some(k => k.kid === kid)) throw new TokenKeyError('TOKEN_ENCRYPTION_KEY: duplicate key id');
    keys.push({ kid, raw });
  }
  if (keys.length === 0) throw new TokenKeyError('TOKEN_ENCRYPTION_KEY is empty');
  return keys;
}

export class TokenCrypto {
  readonly #keys: ParsedKey[];

  private constructor(keys: ParsedKey[]) { this.#keys = keys; }

  /** Throws TokenKeyError when the secret is missing or malformed. */
  static fromEnv(env: CryptoEnv): TokenCrypto {
    return new TokenCrypto(parseKeys(env));
  }

  static isConfigured(env: CryptoEnv): boolean {
    try { parseKeys(env); return true; } catch { return false; }
  }

  /** Id of the key new envelopes are sealed with. */
  get currentKeyId(): string { return this.#keys[0].kid; }

  /** Does this envelope use the current key? (False: re-seal it when convenient.) */
  isCurrent(envelope: string): boolean {
    return envelope.split('.')[1] === this.currentKeyId;
  }

  async seal(material: { access: string; refresh?: string; expiresAt?: number } | TokenMaterial, aad: string): Promise<string> {
    const m = material instanceof TokenMaterial ? { access: material.access(), refresh: material.refresh(), expiresAt: material.expiresAt } : material;
    const key = await this.#aesKey(this.#keys[0]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ a: m.access, r: m.refresh ?? null, e: m.expiresAt ?? null }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
    return `${VERSION}.${this.currentKeyId}.${b64url(iv)}.${b64url(ct)}`;
  }

  async open(envelope: string, aad: string): Promise<TokenMaterial> {
    const [version, kid, ivPart, ctPart, extra] = envelope.split('.');
    if (version !== VERSION || !kid || !ivPart || !ctPart || extra !== undefined) throw new TokenEnvelopeError('token envelope is malformed');
    const k = this.#keys.find(x => x.kid === kid);
    if (!k) throw new TokenEnvelopeError(`token envelope was sealed with key "${kid}", which is no longer configured`);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64url(ivPart) as BufferSource, additionalData: enc.encode(aad) },
        await this.#aesKey(k),
        unb64url(ctPart) as BufferSource,
      );
    } catch {
      throw new TokenEnvelopeError('token envelope does not open (tampered, or bound to another connection)');
    }
    let parsed: { a?: unknown; r?: unknown; e?: unknown };
    try { parsed = JSON.parse(dec.decode(plain)); } catch { throw new TokenEnvelopeError('token envelope is corrupt'); }
    if (typeof parsed.a !== 'string' || !parsed.a) throw new TokenEnvelopeError('token envelope is corrupt');
    return new TokenMaterial({
      access: parsed.a,
      refresh: typeof parsed.r === 'string' ? parsed.r : undefined,
      expiresAt: typeof parsed.e === 'number' ? parsed.e : undefined,
    });
  }

  /** Re-seal an envelope under the current key. */
  async reseal(envelope: string, aad: string): Promise<string> {
    return this.seal(await this.open(envelope, aad), aad);
  }

  /**
   * A purpose-bound HMAC-SHA256 key derived (HKDF) from the current encryption key, so signed OAuth state
   * needs no second secret and a state signature can never be replayed as anything else.
   */
  async hmacKey(purpose: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', this.#keys[0].raw as BufferSource, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('inbox-angel'), info: enc.encode(purpose) },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify'],
    );
  }

  #aesKey(k: ParsedKey): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', k.raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  toJSON(): { redacted: true } { return { redacted: true }; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return 'TokenCrypto { [redacted] }'; }
}

/** What an envelope is bound to. */
export const envelopeAad = (workspaceId: string, connectionId: string) => `${workspaceId}|${connectionId}`;
