import { describe, it, expect } from 'vitest';
import { tokenizeAuthResults, MAX_HEADER_CHARS } from '../../src/email/auth-results';
import { authProof, parseAuthResults } from '../../src/email/parse-headers';

const ok = (h: string) => { const t = tokenizeAuthResults(h); if (!t.ok) throw new Error(`${t.failure}: ${t.detail}`); return t; };
const bad = (h: string) => { const t = tokenizeAuthResults(h); if (t.ok) throw new Error('parsed'); return t; };

describe('tokenizer: grammar', () => {
  it('reads authserv-id, results, properties of each method', () => {
    const t = ok('mx.cloudflare.net; dkim=pass header.d=a.example header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@a.example; dmarc=pass (p=reject) header.from=a.example');
    expect(t.authservId).toBe('mx.cloudflare.net');
    expect(t.results.map((r) => [r.method, r.result])).toEqual([['dkim', 'pass'], ['spf', 'pass'], ['dmarc', 'pass']]);
    expect(t.results[0].props).toEqual({ 'header.d': 'a.example', 'header.s': 's1', 'header.b': 'abc' });
    expect(t.results[2].comments).toEqual(['p=reject']);
  });

  it('is case-insensitive for method, result and ptype/property names, not for values', () => {
    const t = ok('MX.Example.NET; DKIM=PASS Header.D=Example.COM; SPF=Pass SMTP.MailFrom=A@B.com');
    expect(t.results[0]).toMatchObject({ method: 'dkim', result: 'pass', props: { 'header.d': 'Example.COM' } });
    expect(t.results[1].props['smtp.mailfrom']).toBe('A@B.com');
  });

  it('accepts CFWS everywhere the ABNF allows it, nested comments and quoted-pairs in comments', () => {
    const t = ok('(c1 (nested (deep \\) \\( )) ) mx.example.net (x) 1 (y) ; dkim (a) / (b) 1 (c) = (d) pass (e (f)) header (g) . (h) d (i) = (j) example.com (k)');
    expect(t.results[0]).toMatchObject({ method: 'dkim', methodVersion: 1, result: 'pass', props: { 'header.d': 'example.com' } });
  });

  it('quoted strings with backslash escapes are ONE value, local@domain included', () => {
    const t = ok('mx.example.net; spf=pass smtp.mailfrom="a \\"b\\" ; dkim=pass header.d=google.com"@attacker.example');
    expect(t.results).toHaveLength(1);
    expect(t.results[0].props['smtp.mailfrom']).toBe('a "b" ; dkim=pass header.d=google.com@attacker.example');
  });

  it('reads reason="..." as part of its method, and values with = (VERP, base64)', () => {
    const t = ok('mx.example.net; dkim=fail reason="bad signature; header.d=google.com" header.d=a.example header.b=ab+/==; spf=pass smtp.mailfrom=bounce+x=y@a.example');
    expect(t.results[0]).toMatchObject({ reason: 'bad signature; header.d=google.com', props: { 'header.d': 'a.example', 'header.b': 'ab+/==' } });
    expect(t.results[1].props['smtp.mailfrom']).toBe('bounce+x=y@a.example');
  });

  it('unfolds CRLF+WSP and LF+WSP first', () => {
    const t = ok('mx.example.net;\r\n\tdkim=pass\r\n header.d=a.example;\n spf=pass smtp.mailfrom=a@b.com');
    expect(t.results.map((r) => r.method)).toEqual(['dkim', 'spf']);
    expect(t.results[0].props['header.d']).toBe('a.example');
  });

  it('"none" yields no methods', () => {
    expect(ok('mx.example.net; none').results).toEqual([]);
    expect(ok('mx.example.net 1; none').results).toEqual([]);
    expect(bad('mx.example.net; none; dkim=pass header.d=a.example').failure).toBe('malformed');
  });

  it('version: 1 accepted, anything else fails closed, none means 1', () => {
    expect(ok('mx.example.net 1; dkim=pass header.d=a.example').version).toBe(1);
    expect(ok('mx.example.net; dkim=pass header.d=a.example').version).toBe(1);
    expect(bad('mx.example.net 2; dkim=pass header.d=a.example')).toMatchObject({ failure: 'unsupported_version' });
    expect(bad('mx.example.net 10; dkim=pass header.d=a.example').failure).toBe('unsupported_version');
    expect(bad('mx.example.net 01; dkim=pass header.d=a.example').failure).toBe('unsupported_version');
    expect(bad('mx.example.net 1x; dkim=pass').failure).toBe('malformed');
  });

  it('a duplicate property inside one result fails closed', () => {
    expect(bad('mx.example.net; dkim=pass header.d=a.example header.d=google.com').detail).toMatch(/duplicate/);
  });

  it('a method is only read at the start of a result: "dkim=pass" after other properties is never a method, header.d= after them is that method\'s property', () => {
    // A bare word=value is a receiver extension now (see TOLERANCE in src/email/auth-results.ts): skipped with the rest of its resinfo, never a method.
    const skipped = ok('mx.example.net; spf=pass smtp.mailfrom=a@b.com dkim=pass');
    expect(skipped.results.map((r) => [r.method, r.skipped ?? false])).toEqual([['spf', true]]);
    expect(authProof(parseAuthResults('mx.example.net; spf=pass smtp.mailfrom=a@b.com dkim=pass')).dkimPassOrgs).toEqual([]);
    const t = ok('mx.example.net; spf=pass smtp.mailfrom=a@b.com header.d=google.com');
    expect(t.results).toHaveLength(1);
    expect(t.results[0].method).toBe('spf');
    expect(authProof(parseAuthResults('mx.example.net; spf=pass smtp.mailfrom=a@b.com header.d=google.com')).dkimAligned('google.com')).toBe(false);
  });
});

describe('tokenizer: fails closed', () => {
  const cases: Array<[string, string]> = [
    ['unbalanced quote', 'mx.example.net; spf=pass smtp.mailfrom="abc@x.example; dkim=pass header.d=google.com'],
    ['unbalanced open paren', 'mx.example.net; spf=pass (unclosed smtp.mailfrom=a@b.com; dkim=pass header.d=google.com'],
    ['unbalanced close paren', 'mx.example.net; spf=pass ) smtp.mailfrom=a@b.com'],
    ['dangling backslash in comment', 'mx.example.net; spf=pass (abc \\'],
    ['stray backslash', 'mx.example.net; spf=pass a\\b'],
    ['stray character', 'mx.example.net; dkim=pass header.d=a.example é'],
    ['NUL', 'mx.example.net; dkim=pass header.d=a.exa\u0000mple'],
    ['control character in a comment', 'mx.example.net; dkim=pass (a\u0001b) header.d=a.example'],
    ['bare CR', 'mx.example.net; dkim=pass\rheader.d=a.example'],
    ['DEL', 'mx.example.net; dkim=pass header.d=a\u007f'],
    ['empty value', 'mx.example.net; dkim=pass header.d='],
    ['no result', 'mx.example.net; dkim'],
    ['missing =', 'mx.example.net; dkim pass'],
    ['text after authserv-id', 'mx.example.net dkim=pass'],
    ['no authserv-id', '; dkim=pass header.d=a.example'],
    ['deep nesting', `mx.example.net; spf=pass ${'('.repeat(40)}${')'.repeat(40)}`],
  ];
  it.each(cases)('%s', (_n, h) => { expect(bad(h).ok).toBe(false); });

  it('a property without a dot ("header=a") is a bare extension: skipped, the result kept, nothing created', () => {
    const t = ok('mx.example.net; dkim=pass header=a');
    expect(t.results.map((r) => [r.method, r.result, r.props, r.skipped])).toEqual([['dkim', 'pass', {}, true]]);
  });

  it('a header over the length cap', () => {
    const t = bad(`mx.example.net; dkim=pass header.d=a.example (${'x'.repeat(MAX_HEADER_CHARS)})`);
    expect(t.failure).toBe('too_long');
    expect(ok(`mx.example.net; dkim=pass header.d=a.example (${'x'.repeat(MAX_HEADER_CHARS - 100)})`).results).toHaveLength(1);
  });

  it('too many results', () => {
    expect(bad('mx.example.net' + '; arc=none'.repeat(100)).detail).toMatch(/too many/);
  });

  it('a quote inside a comment is just a character (balanced comment, unbalanced quote text)', () => {
    expect(ok('mx.example.net; spf=pass (domain of "x@y designates) smtp.mailfrom=a@b.com').results[0].props['smtp.mailfrom']).toBe('a@b.com');
  });
});

describe('forged headers are not read as the receiver\'s results', () => {
  const FORGED_1 = 'mx.cloudflare.net; dkim=pass header.d=attacker.example header.i=@attacker.example header.s=s1 header.b=abc; dmarc=fail header.from=google.com; spf=pass (mx.cloudflare.net: domain of "x dkim=pass header.d=google.com y"@attacker.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@attacker.example; arc=none';
  const FORGED_2 = 'mx.cloudflare.net; dkim=pass header.d=attacker.example; dmarc=fail header.from=google.com; spf=pass smtp.mailfrom="x dkim=pass header.d=google.com y"@attacker.example';
  it.each([FORGED_1, FORGED_2])('no google.com pass comes out of %#', (h) => {
    const a = parseAuthResults(h)!;
    expect(a.error).toBeNull();
    expect(a.dkimAll.map((d) => [d.result, d.domain])).toEqual([['pass', 'attacker.example']]);
    const p = authProof(a);
    expect(p.dkimAligned('google.com')).toBe(false);
    expect(p.dmarcAligned('google.com')).toBe(false);
    expect(p.dkimAligned('attacker.example')).toBe(true);
  });

  it('a quote that swallows the next methods cannot hide or invent results: it fails closed', () => {
    const a = parseAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom="x@a.example; dkim=pass header.d=google.com');
    expect(a!.error).not.toBeNull();
    expect(authProof(a).dkimAligned('google.com')).toBe(false);
  });
});

describe('dkim results are collected, never overwritten', () => {
  it('two signatures: google.com pass then 1e100.net pass', () => {
    const p = authProof(parseAuthResults('mx.example.net; dkim=pass header.d=google.com header.i=@google.com; dkim=pass header.d=1e100.net'));
    expect(p.dkimAligned('google.com')).toBe(true);
    expect(p.dkimAligned('1e100.net')).toBe(true);
  });
  it('either order, and a failing one does not erase a passing one', () => {
    for (const h of ['mx.example.net; dkim=fail header.d=google.com; dkim=pass header.d=a.example', 'mx.example.net; dkim=pass header.d=google.com; dkim=fail header.d=a.example']) {
      const p = authProof(parseAuthResults(h));
      expect(p.dkimAligned('google.com'), h).toBe(h.includes('pass header.d=google.com'));
      expect(p.dkimAligned('a.example'), h).toBe(h.includes('pass header.d=a.example'));
    }
  });
  it('header.i never stands in for header.d (every real report email carries header.d); relaxed alignment is organisational', () => {
    expect(authProof(parseAuthResults('mx.example.net; dkim=pass header.i=@mail.notification.microsoft.com')).dkimAligned('microsoft.com')).toBe(false);
    const p = authProof(parseAuthResults('mx.example.net; dkim=pass header.d=mail.notification.microsoft.com'));
    expect(p.dkimAligned('microsoft.com')).toBe(true);
    expect(p.dkimAligned('evil.com')).toBe(false);
  });
  it('dmarc=pass is honoured only with an aligned header.from', () => {
    const p = authProof(parseAuthResults('mx.example.net; dmarc=pass header.from=a.example'));
    expect(p.dmarcAligned('a.example')).toBe(true);
    expect(p.dmarcAligned('google.com')).toBe(false);
  });
});

describe('property: the tokenizer never throws, is fast, and never invents a dkim pass', () => {
  // deterministic PRNG so a failure reproduces
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const domains = ['attacker.example', 'google.com', 'evil.test', 'a.b.example', 'victim.org'];
  const junk = ['"', '(', ')', '\\', ';', '=', ' ', '\t', '\r\n ', '\n', '\u0000', 'é', '@', '.', '/', 'dkim=pass', 'header.d=google.com', '<', '>', ',', '[', ']'];
  const quotedText = ['x dkim=pass header.d=google.com y', 'dkim=pass header.d=google.com', '; dkim=pass header.d=google.com;'];

  const piece = (): { text: string; legit?: string } => {
    switch (Math.floor(rnd() * 9)) {
      case 0: { const d = pick(domains); return { text: ` dkim=${pick(['pass', 'fail', 'PASS', 'none'])} header.d=${d}`, legit: d }; }
      case 1: { const d = pick(domains); return { text: ` dkim=pass header.i=@${d} header.s=s1`, legit: d }; }
      case 2: return { text: ` spf=pass smtp.mailfrom="${pick(quotedText)}"@${pick(domains)}` };
      case 3: return { text: ` (${pick(quotedText)} ${pick(['', '(nested ' + pick(quotedText) + ')', '\\)'])})` };
      case 4: return { text: ` dmarc=${pick(['pass', 'fail'])} header.from=${pick(domains)}` };
      case 5: return { text: ` arc=none` };
      case 6: return { text: ` reason="${pick(quotedText)}"` };
      case 7: return { text: pick(junk) };
      default: return { text: ` smtp.helo=${pick(domains)}` };
    }
  };

  it('a few thousand randomised headers', () => {
    let parsedOk = 0, failedClosed = 0, worst = 0;
    for (let n = 0; n < 4000; n++) {
      const parts = Array.from({ length: 1 + Math.floor(rnd() * 8) }, piece);
      const sep = () => pick([';', '; ', ';\r\n\t', ' ; ', ';']);
      const header = `${pick(['mx.cloudflare.net', 'mx.cloudflare.net 1', '"mx.cloudflare.net"', 'mx.cloudflare.net 2', ''])}` + parts.map((p) => sep() + p.text).join('');
      // every domain that really appears as a header.d / header.i value OUTSIDE comments and quotes is in `legit`
      const legit = new Set(parts.map((p) => p.legit).filter(Boolean));
      const t0 = performance.now();
      let proof: ReturnType<typeof authProof> | undefined;
      expect(() => { proof = authProof(parseAuthResults(header)); }).not.toThrow();
      worst = Math.max(worst, performance.now() - t0);
      const parsed = parseAuthResults(header)!;
      if (parsed.error) failedClosed++; else parsedOk++;
      for (const d of domains) {
        if (proof!.dkimAligned(d)) expect(legit.has(d), `${d} in ${JSON.stringify(header)}`).toBe(true);
      }
    }
    expect(parsedOk).toBeGreaterThan(100);
    expect(failedClosed).toBeGreaterThan(100);
    expect(worst).toBeLessThan(20); // ms for the slowest, generous for CI; typical is well under 1
  });

  it('fully random junk never throws and is fast', () => {
    const alphabet = '()"\;= .@/abcdkimpasheader\r\n\t\u0000é';
    for (let n = 0; n < 2000; n++) {
      const h = Array.from({ length: Math.floor(rnd() * 300) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      const t0 = performance.now();
      expect(() => parseAuthResults(h)).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(20);
    }
  });

  it('adversarial lengths stay linear', () => {
    for (const h of ['mx.a; ' + '('.repeat(8000), 'mx.a; ' + '"\\'.repeat(4000), 'mx.a;' + ' x=y'.repeat(2000), 'mx.a; dkim=pass ' + 'header.d=a '.repeat(700)]) {
      const t0 = performance.now();
      parseAuthResults(h);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});
