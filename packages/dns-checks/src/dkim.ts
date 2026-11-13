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

/** Reads a record's text as the resolver returns it (already decoded: see `decodeTxtData`). Decoding happens once, at the boundary. */
export function parseDkimRecord(rawContent: string): DkimRecord {
  const raw = rawContent.trim();
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

const DKIM_TAGS = new Set(['v', 'p', 'k', 'h', 's', 't', 'n', 'g']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Is this TXT record shaped like a DKIM key record? A wildcard TXT (gov.uk answers every name with its DMARC record) must not
 * read as a key, so a DMARC or SPF record is refused first. A record that opens with `v=DKIM1` and has a `p=` tag is a key
 * whatever other tags it carries: RFC 6376 §3.6.1 says unknown tags are ignored. Their names must still be well formed, and
 * `p=` must be empty (revoked) or base64. Without `v=`, the record needs the same `p=` and no tags other than the DKIM ones
 * (k, h, s, t, n, g). An escaped semicolon (`\;`) stays inside the value of the tag it sits in.
 */
export function isDkimRecord(txt: string): boolean {
  const t = txt.trim().replace(/^["'\s]+/, '').replace(/["'\s]+$/, '');
  if (/^v=\s*(DMARC1|spf1)/i.test(t)) return false;
  const tags = new Map<string, string>();
  let first: string | undefined;
  for (const part of t.split(/(?<!\\);/)) {
    if (!part.trim()) continue;
    const i = part.indexOf('=');
    if (i < 0) return false;
    const k = part.slice(0, i).trim().toLowerCase();
    if (!TAG_NAME.test(k)) return false;
    first ??= k;
    if (!tags.has(k)) tags.set(k, part.slice(i + 1).replace(/[\s"']+/g, ''));
  }
  const p = tags.get('p');
  if (p === undefined || !BASE64.test(p)) return false;
  const v = tags.get('v');
  if (v !== undefined) return first === 'v' && v.toUpperCase() === 'DKIM1';
  return [...tags.keys()].every(k => DKIM_TAGS.has(k));
}

export type DkimLookupStatus = 'found' | 'none' | 'error';

export interface DkimLookup {
  status: DkimLookupStatus;
  selector: string;
  name: string;
  record: DkimRecord | null;
  /** Every TXT record the name answered with (DKIM-shaped or not): the wildcard check compares these. */
  txt: string[];
  error?: string;
}

export async function lookupDkim(resolver: Resolver, domain: string, selector: string): Promise<DkimLookup> {
  const name = `${selector}._domainkey.${normalizeName(domain)}`;
  const r = await resolver.txt(name);
  if (r.status === 'error') return { status: 'error', selector, name, record: null, txt: [], error: r.error ?? 'DNS error' };
  const raw = r.records.find(isDkimRecord);
  return raw
    ? { status: 'found', selector, name, record: parseDkimRecord(raw), txt: r.records }
    : { status: 'none', selector, name, record: null, txt: r.records };
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
  /** Every name that answered returned the same TXT record, so the answers say nothing about which selectors exist. */
  wildcard: boolean;
  /** The record every probed name answered with, when `wildcard`. */
  wildcardRecord: string | null;
}

export const DKIM_WILDCARD_MIN_ANSWERS = 3;

/**
 * Given what each probed selector answered (empty array: no TXT record), the one record they all share, or null. At least
 * {@link DKIM_WILDCARD_MIN_ANSWERS} names must have answered and every answer must be identical.
 */
export function sharedWildcardRecord(answers: readonly (readonly string[])[]): string | null {
  const answered = answers.filter(a => a.length > 0).map(a => [...a].sort().join('\n'));
  if (answered.length < DKIM_WILDCARD_MIN_ANSWERS || answered.some(a => a !== answered[0])) return null;
  return answers.find(a => a.length > 0)![0];
}

export async function scanDkimSelectors(
  resolver: Resolver,
  domain: string,
  selectors: readonly string[] = COMMON_DKIM_SELECTORS,
): Promise<DkimScan> {
  const results = await Promise.all(selectors.map(s => lookupDkim(resolver, domain, s)));
  const wildcardRecord = sharedWildcardRecord(results.filter(r => r.status !== 'error').map(r => r.txt));
  return {
    // A wildcard cannot tell us which selector a sender uses, whatever it answers.
    found: wildcardRecord === null ? results.filter(r => r.status === 'found') : [],
    errors: results.filter(r => r.status === 'error'),
    scanned: results.length,
    wildcard: wildcardRecord !== null,
    wildcardRecord,
  };
}
