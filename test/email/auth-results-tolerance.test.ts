// Tolerance for receiver extensions inside a resinfo ("action=none"), and what it must never do: create a pass.
import { describe, it, expect } from 'vitest';
import { tokenizeAuthResults } from '../../src/email/auth-results';
import { authProof, parseAuthResults } from '../../src/email/parse-headers';
import { carrierFromHeaders, envelopeIsPlain, guardEnvelope } from '../../src/dmarc/reporter-auth';

const ID = 'mx.cloudflare.net';
const ok = (h: string) => {
  const r = tokenizeAuthResults(h);
  if (!r.ok) throw new Error(`expected ok, got ${r.failure}: ${r.detail}`);
  return r;
};
const passOrgs = (h: string) => authProof(parseAuthResults(h)).dkimPassOrgs;

describe('a bare word=value extension is skipped, not fatal', () => {
  it('keeps the method, its result and the properties read before it; skips the rest of that resinfo only', () => {
    const r = ok(`${ID}; dkim=pass header.d=google.com action=none header.s=x; spf=pass smtp.mailfrom=b@google.com`);
    expect(r.results.map((x) => [x.method, x.result, x.props, x.skipped ?? false])).toEqual([
      ['dkim', 'pass', { 'header.d': 'google.com' }, true],
      ['spf', 'pass', { 'smtp.mailfrom': 'b@google.com' }, false],
    ]);
    expect(passOrgs(`${ID}; dkim=pass header.d=google.com action=none`)).toEqual(['google.com']);
  });

  it('a skipped extension can lose a pass (header.d after it is dropped), never create one', () => {
    expect(passOrgs(`${ID}; dkim=pass action=none header.d=google.com`)).toEqual([]);
    // "dkim=pass ..." inside the skipped part is not a method: a method only starts after a top-level ";"
    expect(passOrgs(`${ID}; spf=pass action=x dkim=pass header.d=google.com`)).toEqual([]);
    expect(passOrgs(`${ID}; spf=pass action="x; dkim=pass header.d=google.com"`)).toEqual([]);
    expect(passOrgs(`${ID}; spf=pass action=x (; dkim=pass header.d=google.com)`)).toEqual([]);
  });

  it('structural errors still fail the whole header closed', () => {
    for (const [h, detail] of [
      [`${ID}; dkim=pass header.d=google.com action="unclosed`, /unbalanced quote/],
      [`${ID}; dkim=pass header.d=google.com action=x (unclosed`, /unbalanced parenthesis/],
      [`${ID}; dkim=pass header.d=google.com action=x) more`, /stray/],
      [`${ID}; dkim=pass header.d=google.com action=x\u0001`, /control character/],
      [`${ID}; dkim=pass header.d=google.com stray-word`, /"\." expected/], // a bare word without "=" is not an extension
      [`${ID}; dkim header.d=google.com`, /"=" expected after the method/],
      [`${ID} 2; dkim=pass header.d=google.com action=none`, /not supported/],
    ] as const) {
      const r = tokenizeAuthResults(h);
      expect(r.ok, h).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(detail);
    }
  });
});

describe('the residual forged header (a receiver copying an unquoted envelope sender)', () => {
  const ENVELOPE = 'x;dkim=pass header.d=google.com;arc=none smtp.x=y@attacker.example';
  const HEADER = `${ID}; spf=pass smtp.mailfrom=${ENVELOPE}`;
  const env = { AUTHSERV_ID: ID, AUTHSERV_HEADER: 'ar' };

  it('the tokenizer alone cannot tell it from a real header: it reads a google.com DKIM pass (documented)', () => {
    expect(passOrgs(HEADER)).toEqual(['google.com']);
  });

  it('safest reading: a carrier whose envelope sender is not a plain address is not believed', () => {
    const carrier = carrierFromHeaders({ ar: HEADER, arc: null, from: 'noreply-dmarc-support@google.com' }, env);
    expect(carrier).toMatchObject({ authenticated: true, class: 'registry' }); // what the header alone would give
    expect(envelopeIsPlain(ENVELOPE)).toBe(false);
    expect(guardEnvelope(carrier, ENVELOPE)).toMatchObject({ authenticated: false, class: 'unauthenticated', reason: 'authres_malformed', candidates: [] });
    // a real reporter's plain envelope sender is untouched
    expect(guardEnvelope(carrier, 'noreply-dmarc-support@google.com')).toBe(carrier);
    expect(envelopeIsPlain('')).toBe(true);
    for (const e of ['"a b"@x.example', 'a(b)@x.example', 'a,b@x.example', 'a\\b@x.example']) expect(envelopeIsPlain(e), e).toBe(false);
  });
});
