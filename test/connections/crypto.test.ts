import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { TokenCrypto, TokenEnvelopeError, TokenKeyError, TokenMaterial, b64url, envelopeAad } from '../../src/connections/crypto';

const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const K1 = `k1:${key(1)}`;
const K2 = `k2:${key(2)}`;
const SECRET = 'cf-access-token-SECRET-1234567890';
const REFRESH = 'cf-refresh-token-SECRET-abcdefghij';
const AAD = envelopeAad('acct_a', 'cfc_1');

describe('token envelope', () => {
  it('round-trips access, refresh and expiry', async () => {
    const c = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K1 });
    const envelope = await c.seal({ access: SECRET, refresh: REFRESH, expiresAt: 1_800_000_000 }, AAD);
    const m = await c.open(envelope, AAD);
    expect(m.access()).toBe(SECRET);
    expect(m.refresh()).toBe(REFRESH);
    expect(m.expiresAt).toBe(1_800_000_000);
  });

  it('never contains the token: not in plain, base64 or base64url form, and every seal differs', async () => {
    const c = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K1 });
    const a = await c.seal({ access: SECRET, refresh: REFRESH }, AAD);
    const b = await c.seal({ access: SECRET, refresh: REFRESH }, AAD);
    expect(a).not.toBe(b);
    for (const env of [a, b]) {
      for (const t of [SECRET, REFRESH]) {
        expect(env).not.toContain(t);
        expect(env).not.toContain(btoa(t));
        expect(env).not.toContain(b64url(new TextEncoder().encode(t)));
        // the decoded ciphertext does not contain it either
        const raw = atob(env.split('.')[3].replace(/-/g, '+').replace(/_/g, '/'));
        expect(raw).not.toContain(t);
      }
    }
    expect(a.startsWith('ia1.k1.')).toBe(true);
  });

  it('does not open for another row, a tampered ciphertext, or the wrong key', async () => {
    const c = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K1 });
    const envelope = await c.seal({ access: SECRET }, AAD);
    await expect(c.open(envelope, envelopeAad('acct_b', 'cfc_1'))).rejects.toBeInstanceOf(TokenEnvelopeError);
    await expect(c.open(envelope, envelopeAad('acct_a', 'cfc_2'))).rejects.toBeInstanceOf(TokenEnvelopeError);
    const parts = envelope.split('.');
    const flipped = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
    await expect(c.open([...parts.slice(0, 3), flipped].join('.'), AAD)).rejects.toBeInstanceOf(TokenEnvelopeError);
    await expect(c.open('nonsense', AAD)).rejects.toBeInstanceOf(TokenEnvelopeError);
    const other = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `k1:${key(9)}` });
    await expect(other.open(envelope, AAD)).rejects.toBeInstanceOf(TokenEnvelopeError);
  });

  it('errors never carry the plaintext', async () => {
    const c = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K1 });
    const envelope = await c.seal({ access: SECRET, refresh: REFRESH }, AAD);
    const e = await c.open(envelope, 'wrong').catch(x => x as Error);
    expect(String(e.message) + String(e.stack)).not.toContain(SECRET);
  });

  it('rotates keys: the first key seals, older keys still open, and reseal moves an envelope forward', async () => {
    const old = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K1 });
    const sealedOld = await old.seal({ access: SECRET, refresh: REFRESH }, AAD);

    const rotated = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `${K2},${K1}` });
    expect(rotated.currentKeyId).toBe('k2');
    expect(rotated.isCurrent(sealedOld)).toBe(false);
    expect((await rotated.open(sealedOld, AAD)).access()).toBe(SECRET);

    const moved = await rotated.reseal(sealedOld, AAD);
    expect(moved.startsWith('ia1.k2.')).toBe(true);
    expect(rotated.isCurrent(moved)).toBe(true);
    expect((await rotated.open(moved, AAD)).refresh()).toBe(REFRESH);

    // once k1 is dropped from the secret, an envelope still on k1 says so (and does not decrypt)
    const dropped = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K2 });
    await expect(dropped.open(sealedOld, AAD)).rejects.toThrow(/no longer configured/);
    expect((await dropped.open(moved, AAD)).access()).toBe(SECRET);
  });

  it('refuses a missing or malformed key with a clear error', () => {
    expect(() => TokenCrypto.fromEnv({})).toThrow(TokenKeyError);
    expect(() => TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: 'k1:c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `${K1},${K1}` })).toThrow(/duplicate/);
    expect(TokenCrypto.isConfigured({})).toBe(false);
    expect(TokenCrypto.isConfigured({ TOKEN_ENCRYPTION_KEY: key(3) })).toBe(true); // bare key: id k1
  });

  it('opened material and the crypto object refuse JSON, string and inspect output', async () => {
    const c = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: K1 });
    const m = await c.open(await c.seal({ access: SECRET, refresh: REFRESH }, AAD), AAD);
    for (const out of [JSON.stringify(m), String(m), inspect(m, { depth: 5 }), `${m}`, JSON.stringify({ m }), JSON.stringify(c), inspect(c)]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(REFRESH);
      expect(out).not.toContain(key(1));
    }
    expect(new TokenMaterial({ access: 'a', expiresAt: 100 }).expired(30)).toBe(false);
    expect(new TokenMaterial({ access: 'a', expiresAt: 100 }).expired(50)).toBe(true);
  });
});

describe('TOKEN_ENCRYPTION_KEY configuration', () => {
  it('requires explicit ids as soon as there is more than one key (position is never an identity)', () => {
    expect(() => TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `${key(2)},${key(1)}` })).toThrow(/every key needs an explicit id/);
    expect(() => TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `k2:${key(2)},${key(1)}` })).toThrow(/every key needs an explicit id/);
    expect(() => TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `${key(2)},k1:${key(1)}` })).toThrow(TokenKeyError);
    expect(TokenCrypto.isConfigured({ TOKEN_ENCRYPTION_KEY: `${key(2)},${key(1)}` })).toBe(false);
    expect(TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `k2:${key(2)},k1:${key(1)}` }).currentKeyId).toBe('k2');
  });

  it('rotating by prepending a new key keeps old envelopes openable, including those sealed under a lone bare key', async () => {
    const bare = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: key(1) }); // a single key without an id means k1
    expect(bare.currentKeyId).toBe('k1');
    const sealed = await bare.seal({ access: SECRET, refresh: REFRESH }, AAD);
    expect(sealed.startsWith('ia1.k1.')).toBe(true);

    const rotated = TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: `k2:${key(2)},k1:${key(1)}` });
    expect((await rotated.open(sealed, AAD)).access()).toBe(SECRET);
    expect(rotated.isCurrent(sealed)).toBe(false);
    expect((await rotated.open(await rotated.seal({ access: SECRET }, AAD), AAD)).access()).toBe(SECRET);
  });
});
