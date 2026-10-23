// What a domain's intake token may file reports for: that domain and its subdomains, nothing else.
// Not other domains of the same workspace, not a parent, not a sibling.

import { normalizeDomain, organizationalDomain } from '@inbox-angel/dns-checks';

export interface TokenDomain { id: number; domain: string }

/** True when `reportDomain` is `tokenDomain` or a subdomain of it (and both sit under one registrable domain, so a public suffix never matches). */
export function coversDomain(tokenDomain: string, reportDomain: string): boolean {
  const t = normalizeDomain(tokenDomain);
  const r = normalizeDomain(reportDomain);
  const org = organizationalDomain(t);
  if (!org || organizationalDomain(r) !== org) return false;
  return r === t || r.endsWith(`.${t}`);
}
