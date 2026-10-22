// DMARC (RFC 7489): parsing, policy discovery with the organizational-domain fallback,
// and a policy grade.

import { normalizeName, type Resolver } from './doh';
import { organizationalDomain } from './org-domain';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface DmarcRecord {
  raw: string;
  policy: DmarcPolicy;
  subdomainPolicy: DmarcPolicy;
  pct: number;
  rua: string[];
  ruf: string[];
  /** adkim / aspf alignment modes ('r' relaxed default, 's' strict) */
  adkim: 'r' | 's';
  aspf: 'r' | 's';
  /** Problems found while parsing; a record with `valid === false` is not enforceable. */
  valid: boolean;
  issues: string[];
}

export function isDmarcRecord(txt: string): boolean {
  return /^\s*v=DMARC1\s*(;|$)/i.test(txt);
}

function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (k && !(k in tags)) tags[k] = part.slice(i + 1).trim();
  }
  return tags;
}

const POLICIES = new Set(['none', 'quarantine', 'reject']);

function asPolicy(v: string | undefined): DmarcPolicy | null {
  const l = v?.toLowerCase();
  return l && POLICIES.has(l) ? (l as DmarcPolicy) : null;
}

export function parseDmarcRecord(raw: string): DmarcRecord {
  const tags = parseTags(raw);
  const issues: string[] = [];

  const p = asPolicy(tags['p']);
  if (tags['p'] === undefined) issues.push('Missing required p= tag');
  else if (!p) issues.push(`Invalid p= value "${tags['p']}"`);
  const policy: DmarcPolicy = p ?? 'none';

  let sp = policy;
  if (tags['sp'] !== undefined) {
    const parsed = asPolicy(tags['sp']);
    if (parsed) sp = parsed;
    else issues.push(`Invalid sp= value "${tags['sp']}"`);
  }

  let pct = 100;
  if (tags['pct'] !== undefined) {
    const n = /^\d+$/.test(tags['pct']) ? parseInt(tags['pct'], 10) : NaN;
    if (Number.isNaN(n) || n > 100) issues.push(`Invalid pct= value "${tags['pct']}"`);
    else pct = n;
  }

  const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    raw,
    policy,
    subdomainPolicy: sp,
    pct,
    rua: list(tags['rua']),
    ruf: list(tags['ruf']),
    adkim: tags['adkim']?.toLowerCase() === 's' ? 's' : 'r',
    aspf: tags['aspf']?.toLowerCase() === 's' ? 's' : 'r',
    valid: !issues.some(i => i.startsWith('Missing required p=') || i.startsWith('Invalid p=')),
    issues,
  };
}

// ── Discovery ────────────────────────────────────────────────

export type DmarcLookupStatus =
  /** a DMARC record was found */
  | 'found'
  /** authoritatively no DMARC record at the domain or its organizational domain */
  | 'none'
  /** more than one v=DMARC1 record at the same name: RFC 7489 §6.6.3 – DMARC does not apply */
  | 'multiple'
  /** DNS failure: we do not know whether a record exists */
  | 'error';

export interface DmarcLookup {
  status: DmarcLookupStatus;
  domain: string;
  record: DmarcRecord | null;
  /** The name the record was found at (e.g. `_dmarc.example.com`). */
  foundAt: string | null;
  /** true when the record came from the organizational domain, not the queried domain */
  inherited: boolean;
  organizationalDomain: string | null;
  error?: string;
}

/**
 * RFC 7489 §6.6.3 discovery: query `_dmarc.<domain>`; if there is no usable record and
 * `<domain>` is not already its organizational domain, query `_dmarc.<org domain>`.
 * The organizational domain comes from the Public Suffix List – `mail.example.co.uk`
 * falls back to `example.co.uk`, never `co.uk`.
 */
export async function lookupDmarc(resolver: Resolver, domain: string): Promise<DmarcLookup> {
  const name = normalizeName(domain);
  const org = organizationalDomain(name);
  const base: DmarcLookup = { status: 'none', domain: name, record: null, foundAt: null, inherited: false, organizationalDomain: org };

  const names = [name];
  if (org && org !== name) names.push(org);

  for (const [i, n] of names.entries()) {
    const at = `_dmarc.${n}`;
    const r = await resolver.txt(at);
    if (r.status === 'error') return { ...base, status: 'error', error: r.error ?? 'DNS error' };
    const matches = r.records.filter(isDmarcRecord);
    if (matches.length > 1) return { ...base, status: 'multiple', foundAt: at, inherited: i > 0 };
    if (matches.length === 1) {
      return { ...base, status: 'found', record: parseDmarcRecord(matches[0].trim()), foundAt: at, inherited: i > 0 };
    }
  }
  return base;
}

// ── Grading ──────────────────────────────────────────────────

export type DmarcGrade =
  /** no usable record */
  | 'missing'
  /** p=none: monitoring only */
  | 'monitoring'
  /** quarantine/reject but applied to < 100% of mail */
  | 'partial'
  /** quarantine at 100% */
  | 'enforced'
  /** reject at 100% */
  | 'strict';

export function gradeDmarcPolicy(record: DmarcRecord | null): DmarcGrade {
  if (!record || !record.valid) return 'missing';
  if (record.policy === 'none') return 'monitoring';
  if (record.pct < 100) return 'partial';
  return record.policy === 'reject' ? 'strict' : 'enforced';
}
