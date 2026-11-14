import { describe, it, expect } from 'vitest';
import {
  parseAuthResults,
  extractAuthResults,
} from '../../src/email/parse-headers';

describe('parseAuthResults', () => {
  it('returns null for null/undefined/empty header', () => {
    expect(parseAuthResults(null)).toBeNull();
    expect(parseAuthResults(undefined)).toBeNull();
    expect(parseAuthResults('')).toBeNull();
  });

  it('parses a fully passing header (Google style)', () => {
    const header = [
      'mx.google.com;',
      ' dkim=pass header.d=example.com header.i=@example.com header.s=selector1 header.b=abc123;',
      ' spf=pass (google.com: domain of user@example.com designates 1.2.3.4 as permitted) smtp.mailfrom=user@example.com;',
      ' dmarc=pass (p=reject dis=none) header.from=example.com',
    ].join('');

    const result = parseAuthResults(header);
    expect(result).not.toBeNull();
    expect(result!.dkim!.result).toBe('pass');
    expect(result!.dkim!.domain).toBe('example.com');
    expect(result!.dkim!.selector).toBe('selector1');
    expect(result!.spf!.result).toBe('pass');
    expect(result!.spf!.domain).toBe('example.com');
    expect(result!.dmarc!.result).toBe('pass');
    expect(result!.dmarc!.domain).toBe('example.com');
    // header.i alone is never the DKIM domain
    expect(parseAuthResults('mx.google.com; dkim=pass header.i=@example.com')!.dkim!.domain).toBeNull();
    expect(result!.dmarc!.policy).toBe('reject');
    expect(result!.dmarc!.disposition).toBe('none');
  });

  it('parses header.d instead of header.i for DKIM domain', () => {
    const header = 'mx.google.com; dkim=pass header.d=sendgrid.net header.s=s1';
    const result = parseAuthResults(header);
    expect(result!.dkim!.domain).toBe('sendgrid.net');
    expect(result!.dkim!.selector).toBe('s1');
  });

  it('parses spf fail with smtp.helo domain', () => {
    const header = 'mx.example.com; spf=fail smtp.helo=mail.spammer.com';
    const result = parseAuthResults(header);
    expect(result!.spf!.result).toBe('fail');
    expect(result!.spf!.domain).toBe('mail.spammer.com');
  });

  it('parses spf softfail', () => {
    const header = 'inbound.example.com; spf=softfail smtp.mailfrom=user@example.org';
    const result = parseAuthResults(header);
    expect(result!.spf!.result).toBe('softfail');
    expect(result!.spf!.domain).toBe('example.org');
  });

  it('parses dmarc=fail with no comment', () => {
    const header = 'mx.example.com; dmarc=fail header.from=example.com';
    const result = parseAuthResults(header);
    expect(result!.dmarc!.result).toBe('fail');
    expect(result!.dmarc!.policy).toBeNull();
    expect(result!.dmarc!.disposition).toBeNull();
  });

  it('handles clause order: spf first, then dkim, then dmarc', () => {
    const header = [
      'server.example.net;',
      ' spf=pass smtp.mailfrom=from@domain.com;',
      ' dkim=fail header.d=domain.com header.s=key1;',
      ' dmarc=none (p=none dis=none) header.from=domain.com',
    ].join('');

    const result = parseAuthResults(header);
    expect(result!.spf!.result).toBe('pass');
    expect(result!.dkim!.result).toBe('fail');
    expect(result!.dmarc!.result).toBe('none');
  });

  it('handles missing clauses gracefully', () => {
    const header = 'mx.example.com; spf=pass smtp.mailfrom=user@example.com';
    const result = parseAuthResults(header);
    expect(result!.spf).not.toBeNull();
    expect(result!.dkim).toBeNull();
    expect(result!.dmarc).toBeNull();
  });

  it('handles temperror and permerror results', () => {
    const header = [
      'mx.example.com;',
      ' spf=temperror;',
      ' dkim=permerror header.d=example.com',
    ].join('');
    const result = parseAuthResults(header);
    expect(result!.spf!.result).toBe('temperror');
    expect(result!.dkim!.result).toBe('permerror');
  });

  it('stores the raw header string', () => {
    const header = 'mx.example.com; spf=pass smtp.mailfrom=a@b.com';
    const result = parseAuthResults(header);
    expect(result!.raw).toBe(header);
  });

  it('ignores ARC and BIMI clauses without crashing', () => {
    const header = [
      'mx.google.com;',
      ' arc=pass;',
      ' bimi=skipped;',
      ' spf=pass smtp.mailfrom=user@example.com;',
      ' dkim=pass header.d=example.com header.s=sel',
    ].join('');
    const result = parseAuthResults(header);
    expect(result!.spf!.result).toBe('pass');
    expect(result!.dkim!.result).toBe('pass');
  });
});

describe('extractAuthResults', () => {
  const rawHeader = 'mx.google.com; spf=pass smtp.mailfrom=user@example.com';

  it('extracts from a Web Headers object (lowercase key)', () => {
    const headers = new Headers({ 'authentication-results': rawHeader });
    const result = extractAuthResults(headers);
    expect(result!.spf!.result).toBe('pass');
  });

  it('extracts from a Map with lowercase key', () => {
    const map = new Map([['authentication-results', rawHeader]]);
    const result = extractAuthResults(map);
    expect(result!.spf!.result).toBe('pass');
  });

  it('extracts from a Map with original-case key', () => {
    const map = new Map([['Authentication-Results', rawHeader]]);
    const result = extractAuthResults(map);
    expect(result!.spf!.result).toBe('pass');
  });

  it('extracts from a plain object', () => {
    const obj = { 'Authentication-Results': rawHeader };
    const result = extractAuthResults(obj);
    expect(result!.spf!.result).toBe('pass');
  });

  it('returns null when header is absent', () => {
    const headers = new Headers({ 'x-other': 'value' });
    expect(extractAuthResults(headers)).toBeNull();
  });
});
