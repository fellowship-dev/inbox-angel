// Organizational domain lookup using the Public Suffix List.
//
// The PSL snapshot ships inside the `tldts` dependency. Update path: bump `tldts`
// (it republishes with a fresh PSL snapshot regularly; Dependabot is configured for
// this repo) – no code change is needed.
//
// Private-section suffixes (github.io, blogspot.com, …) are honoured so that
// `alice.github.io` and `bob.github.io` are different organizations, matching how
// mailbox providers treat the PSL for DMARC.

import { getDomain, getPublicSuffix } from 'tldts';

const OPTS = { allowPrivateDomains: true } as const;

export function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Organizational domain (registrable domain) of `domain`, e.g.
 * `mail.example.co.uk` → `example.co.uk`. Returns null when `domain` is itself a
 * public suffix (`co.uk`), an IP address, or not a valid hostname – never a bare
 * public suffix.
 */
export function organizationalDomain(domain: string): string | null {
  const d = normalizeDomain(domain);
  if (!d) return null;
  return getDomain(d, OPTS) ?? null;
}

/** True when the name is exactly a public suffix such as `co.uk` or `com`. */
export function isPublicSuffix(domain: string): boolean {
  const d = normalizeDomain(domain);
  return !!d && getPublicSuffix(d, OPTS) === d;
}
