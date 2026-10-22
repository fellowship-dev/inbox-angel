// Sender inventory: DMARC report records rolled up per sending IP, with a provider guess and alignment rates.
//
// D1 keeps each record's raw SPF/DKIM result and authenticated domain, not the report's own "aligned" verdict
// (only the report totals use that). So alignment here is derived the way DMARC defines relaxed alignment:
// the authenticated domain shares the organizational domain of the From domain, and the check passed.
// Limits: only the first SPF and first DKIM result of each record are stored, so a message signed twice
// (an ESP's domain first, yours second) can read as "DKIM not aligned" here though DMARC passed it. Strict
// alignment (adkim=s / aspf=s) is applied only when the caller knows the published record; otherwise relaxed is
// assumed. Every number derived from this is an ESTIMATE and is labelled so: only the reports' own pass/fail
// totals (trend, pass rate) are exact, and only those may block a rollout step.

import { organizationalDomain } from '@inbox-angel/dns-checks/org-domain';
import { identifySender, type SenderProvider } from '@inbox-angel/dns-checks/sender-providers';
import type { SenderRow } from '@inbox-angel/db';

/** A sender whose first report is newer than this is flagged "new" (when older history exists to compare with). */
export const NEW_SENDER_DAYS = 7;

export interface Sender {
  source_ip: string;
  reverse_dns: string | null;
  base_domain: string | null;
  org: string | null;
  country_code: string | null;
  provider: { id: string; name: string; evidence: string } | null;
  domains: string[];
  messages: number;
  /** Share of all mail in scope, 0-100 with one decimal. */
  share_pct: number;
  spf_aligned_pct: number;
  dkim_aligned_pct: number;
  /** Aligned on at least one of SPF or DKIM, i.e. passes DMARC. */
  dmarc_pass_pct: number;
  /** Message counts behind the percentages, for ranking fixes. */
  spf_aligned_messages: number;
  dkim_aligned_messages: number;
  dmarc_fail_messages: number;
  /** The domains it most often authenticated as (SPF envelope domain, DKIM d=). */
  spf_domain: string | null;
  dkim_domain: string | null;
  first_seen: number;
  last_seen: number;
  is_new: boolean;
}

export const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export type AlignMode = 'r' | 's';
export interface AlignModes { spf: AlignMode; dkim: AlignMode }
export const RELAXED = { spf: 'r', dkim: 'r' } as const;

const norm = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');

/** Do the two domains align? Relaxed: same organizational domain. Strict: the same domain. */
export function aligned(a: string | null, b: string | null, mode: AlignMode = 'r'): boolean {
  if (!a || !b) return false;
  if (mode === 's') return norm(a) === norm(b);
  const x = organizationalDomain(a);
  return x !== null && x === organizationalDomain(b);
}

/** Relaxed DMARC alignment of one record against the From domain it was sent as. */
export function recordAlignment(r: Pick<SenderRow, 'header_from' | 'domain' | 'spf_domain' | 'spf_result' | 'dkim_domain' | 'dkim_result'>, modes: AlignModes = RELAXED): { spf: boolean; dkim: boolean } {
  const from = r.header_from || r.domain;
  return {
    spf: r.spf_result === 'pass' && aligned(r.spf_domain, from, modes.spf),
    dkim: r.dkim_result === 'pass' && aligned(r.dkim_domain, from, modes.dkim),
  };
}

export interface BuildOptions {
  now: number;
  /** Unix seconds of the earliest report in scope; "new" only means something when history predates the window. */
  earliest: number | null;
  /** Alignment modes from the published DMARC record (adkim / aspf); relaxed when unknown. */
  align?: AlignModes;
}

/** Rolls rows up per source IP, biggest first. */
export function buildSenders(rows: SenderRow[], { now, earliest, align = RELAXED }: BuildOptions): Sender[] {
  const total = rows.reduce((n, r) => n + r.messages, 0);
  const newCutoff = now - NEW_SENDER_DAYS * 86400;
  // Without anything older than the cutoff, every sender is "first seen" in the window and flagging all of them is noise.
  const haveHistory = earliest !== null && earliest < newCutoff;

  interface Acc {
    rows: SenderRow[];
    messages: number;
    spf: number;
    dkim: number;
    pass: number;
    first: number;
    last: number;
    spfBy: Map<string, number>;
    dkimBy: Map<string, number>;
  }
  const byIp = new Map<string, Acc>();
  for (const r of rows) {
    const a: Acc = byIp.get(r.source_ip) ?? { rows: [], messages: 0, spf: 0, dkim: 0, pass: 0, first: r.first_seen, last: r.last_seen, spfBy: new Map(), dkimBy: new Map() };
    const al = recordAlignment(r, align);
    a.rows.push(r);
    a.messages += r.messages;
    if (al.spf) a.spf += r.messages;
    if (al.dkim) a.dkim += r.messages;
    if (al.spf || al.dkim) a.pass += r.messages;
    a.first = Math.min(a.first, r.first_seen);
    a.last = Math.max(a.last, r.last_seen);
    if (r.spf_domain) a.spfBy.set(r.spf_domain, (a.spfBy.get(r.spf_domain) ?? 0) + r.messages);
    if (r.dkim_domain) a.dkimBy.set(r.dkim_domain, (a.dkimBy.get(r.dkim_domain) ?? 0) + r.messages);
    byIp.set(r.source_ip, a);
  }

  const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const first = <K extends keyof SenderRow>(a: Acc, k: K) => a.rows.map((r) => r[k]).find((v) => v !== null && v !== '') as SenderRow[K] | undefined;

  return [...byIp.entries()]
    .map(([ip, a]): Sender => {
      const spf_domain = top(a.spfBy);
      const dkim_domain = top(a.dkimBy);
      const reverse_dns = first(a, 'reverse_dns') ?? null;
      const base_domain = first(a, 'base_domain') ?? null;
      const org = first(a, 'org') ?? null;
      const p: SenderProvider | null = identifySender({ reverse_dns, base_domain, org, spf_domain, dkim_domain });
      return {
        source_ip: ip,
        reverse_dns,
        base_domain,
        org,
        country_code: first(a, 'country_code') ?? null,
        provider: p ? { id: p.id, name: p.name, evidence: p.evidence } : null,
        domains: [...new Set(a.rows.map((r) => r.domain))].sort(),
        messages: a.messages,
        share_pct: pct(a.messages, total),
        spf_aligned_pct: pct(a.spf, a.messages),
        dkim_aligned_pct: pct(a.dkim, a.messages),
        dmarc_pass_pct: pct(a.pass, a.messages),
        spf_aligned_messages: a.spf,
        dkim_aligned_messages: a.dkim,
        dmarc_fail_messages: a.messages - a.pass,
        spf_domain,
        dkim_domain,
        first_seen: a.first,
        last_seen: a.last,
        is_new: haveHistory && a.first >= newCutoff,
      };
    })
    .sort((x, y) => y.messages - x.messages || x.source_ip.localeCompare(y.source_ip));
}

/** Is `host` the same organizational domain as `domain`? (What SPF alignment needs from an envelope domain under relaxed mode.) */
export const underOrg = (host: string, domain: string): boolean => aligned(host, domain, 'r');
