// DKIM public-key discovery. DKIM selectors are not enumerable, so the scan only proves
// presence: finding nothing among common selectors does NOT mean the domain has no DKIM.

import { normalizeName, type Resolver } from './doh';

export interface DkimRecord {
  raw: string;
  version: string;
  keyType: string;
  present: boolean;
  /** p= is empty: the key has been revoked (RFC 6376 §3.6.1) */
  revoked: boolean;
}

export function parseDkimRecord(raw: string): DkimRecord {
  const tags: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (k && !(k in tags)) tags[k] = part.slice(i + 1).replace(/\s+/g, '').trim();
  }
  return {
    raw,
    version: tags['v'] ?? 'DKIM1',
    keyType: tags['k'] ?? 'rsa',
    present: true,
    revoked: 'p' in tags && tags['p'] === '',
  };
}

function looksLikeDkim(txt: string): boolean {
  return /(^|;)\s*v=DKIM1\s*(;|$)/i.test(txt) || /(^|;)\s*p=/i.test(txt) || /(^|;)\s*k=/i.test(txt);
}

export type DkimLookupStatus = 'found' | 'none' | 'error';

export interface DkimLookup {
  status: DkimLookupStatus;
  selector: string;
  name: string;
  record: DkimRecord | null;
  error?: string;
}

export async function lookupDkim(resolver: Resolver, domain: string, selector: string): Promise<DkimLookup> {
  const name = `${selector}._domainkey.${normalizeName(domain)}`;
  const r = await resolver.txt(name);
  if (r.status === 'error') return { status: 'error', selector, name, record: null, error: r.error ?? 'DNS error' };
  const raw = r.records.find(looksLikeDkim);
  return raw
    ? { status: 'found', selector, name, record: parseDkimRecord(raw) }
    : { status: 'none', selector, name, record: null };
}

/** Selectors commonly published by major senders / mailbox providers. */
export const COMMON_DKIM_SELECTORS: readonly string[] = [
  'default', 'google', 'selector1', 'selector2', 'k1', 'k2', 'k3', 's1', 's2',
  'mandrill', 'mte1', 'resend', 'dkim', 'mail', 'smtp', 'email',
  'amazonses', 'pm', 'pm-bounces', 'mxvault', 'zoho', 'zmail', 'sendgrid', 'smtpapi',
  'mailgun', 'krs', 'scph0120', 'protonmail', 'protonmail2', 'protonmail3', 'fm1', 'fm2', 'fm3', 'cm', 'everlytickey1', 'shopify',
];

export interface DkimScan {
  found: DkimLookup[];
  /** selectors whose lookup failed – the scan is inconclusive for these */
  errors: DkimLookup[];
  scanned: number;
}

export async function scanDkimSelectors(
  resolver: Resolver,
  domain: string,
  selectors: readonly string[] = COMMON_DKIM_SELECTORS,
): Promise<DkimScan> {
  const results = await Promise.all(selectors.map(s => lookupDkim(resolver, domain, s)));
  return {
    found: results.filter(r => r.status === 'found'),
    errors: results.filter(r => r.status === 'error'),
    scanned: results.length,
  };
}
