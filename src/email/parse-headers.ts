// Authentication-Results header parser — RFC 8601 (the tokenizer is src/email/auth-results.ts).
// Extracts SPF, DKIM, DMARC results from inbound email headers.
//
// Example header:
//   Authentication-Results: mx.google.com;
//     dkim=pass header.d=example.com header.s=selector1;
//     spf=pass (google.com: domain of user@example.com ...) smtp.mailfrom=user@example.com;
//     dmarc=pass (p=reject dis=none) header.from=example.com

import { organizationalDomain } from '@ready-set-mail/dns-checks';
import { dkimDomain, domainOfValue, tokenizeAuthResults, type AuthResultInfo, type AuthResultsFailure } from './auth-results';

export type AuthMethodResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';

export interface SpfHeaderResult {
  result: AuthMethodResult;
  domain: string | null;    // smtp.mailfrom or smtp.helo domain
}

export interface DkimHeaderResult {
  result: AuthMethodResult;
  domain: string | null;    // header.d (header.i is never used)
  selector: string | null;  // header.s
}

export interface DmarcHeaderResult {
  result: AuthMethodResult;
  domain: string | null;    // header.from
  policy: string | null;    // p= from comment
  disposition: string | null; // dis= from comment
}

export interface AuthResultsHeader {
  spf: SpfHeaderResult | null;
  /** The first dkim=pass result, else the first dkim result (display only; use `dkimAll` / `authProof` to decide anything). */
  dkim: DkimHeaderResult | null;
  /** EVERY dkim result, in order. Never overwritten: a message with two signatures has two results. */
  dkimAll: DkimHeaderResult[];
  dmarc: DmarcHeaderResult | null;
  dmarcAll: DmarcHeaderResult[];
  authservId: string | null;
  /** Set when the header could not be tokenized cleanly: no result is reported and nothing may be trusted. */
  error: { failure: AuthResultsFailure; detail: string } | null;
  raw: string;
}

const commentTag = (r: AuthResultInfo, key: string): string | null =>
  r.comments.join(' ').match(new RegExp(`(?:^|[\\s;])${key}=(\\w+)`, 'i'))?.[1]?.toLowerCase() ?? null;

/**
 * Parses the Authentication-Results header value with the RFC 8601 tokenizer. Returns null if the header is missing or empty. A header the
 * tokenizer refuses yields an object with `error` set and no results: callers that decide anything from it must treat that as "nothing proven".
 */
export function parseAuthResults(header: string | null | undefined): AuthResultsHeader | null {
  if (!header) return null;
  const t = tokenizeAuthResults(header);
  const empty: AuthResultsHeader = { spf: null, dkim: null, dkimAll: [], dmarc: null, dmarcAll: [], authservId: null, error: null, raw: header };
  if (!t.ok) return { ...empty, error: { failure: t.failure, detail: t.detail } };
  const dkimAll: DkimHeaderResult[] = [];
  const dmarcAll: DmarcHeaderResult[] = [];
  let spf: SpfHeaderResult | null = null;
  for (const r of t.results) {
    if (r.method === 'dkim') {
      dkimAll.push({ result: r.result as AuthMethodResult, domain: dkimDomain(r), selector: r.props['header.s']?.toLowerCase() ?? null });
    } else if (r.method === 'spf' && !spf) {
      spf = { result: r.result as AuthMethodResult, domain: domainOfValue(r.props['smtp.mailfrom']) ?? domainOfValue(r.props['smtp.helo']) };
    } else if (r.method === 'dmarc') {
      dmarcAll.push({ result: r.result as AuthMethodResult, domain: domainOfValue(r.props['header.from']), policy: commentTag(r, 'p'), disposition: commentTag(r, 'dis') });
    }
  }
  return {
    ...empty, spf, dkimAll, dmarcAll, authservId: t.authservId,
    dkim: dkimAll.find((d) => d.result === 'pass') ?? dkimAll[0] ?? null,
    dmarc: dmarcAll.find((d) => d.result === 'pass') ?? dmarcAll[0] ?? null,
  };
}

const orgOf = (d: string | null | undefined): string | null => (d ? (organizationalDomain(d) ?? d.toLowerCase()) : null);

/**
 * What the receiver's results prove about domains, from the tokenized header (nothing at all when it did not tokenize).
 *   dkimPassOrgs    organisational domains of EVERY dkim=pass result (header.d, else the domain of header.i), in order
 *   dkimAligned(d)  some dkim=pass is in the same organisation as `d` (relaxed alignment, DMARC's default; the existing org-domain helper)
 *   dmarcAligned(d) some dmarc=pass has a header.from in the same organisation as `d`
 */
export function authProof(auth: AuthResultsHeader | null) {
  const ok = auth && !auth.error ? auth : null;
  const passOrgs = (rs: Array<{ result: string; domain: string | null }> | undefined) => (rs ?? []).filter((d) => d.result === 'pass').map((d) => orgOf(d.domain)).filter((d): d is string => !!d);
  const dkimPassOrgs = passOrgs(ok?.dkimAll);
  const dmarcPassOrgs = passOrgs(ok?.dmarcAll);
  return {
    dkimPassOrgs,
    dkimAligned: (domain: string | null | undefined) => { const o = orgOf(domain); return !!o && dkimPassOrgs.includes(o); },
    dmarcAligned: (domain: string | null | undefined) => { const o = orgOf(domain); return !!o && dmarcPassOrgs.includes(o); },
  };
}

/**
 * Finds and parses the Authentication-Results header from a raw email header map.
 * Handles multiple Authentication-Results headers (takes the first).
 */
export function extractAuthResults(headers: Headers | Map<string, string> | Record<string, string>): AuthResultsHeader | null {
  let value: string | null | undefined;

  if (headers instanceof Headers) {
    value = headers.get('authentication-results');
  } else if (headers instanceof Map) {
    value = headers.get('authentication-results') ?? headers.get('Authentication-Results');
  } else {
    value = (headers as Record<string, string>)['authentication-results']
      ?? (headers as Record<string, string>)['Authentication-Results'];
  }

  return parseAuthResults(value);
}
