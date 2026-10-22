// Aggregation over per-domain reports. Pure: no I/O. Aggregates are the only publishable artifact
// (and only with approval) — see README guardrails.
import type { DomainReport } from './checker.ts';

export interface Aggregate {
  generatedAt: string;
  totals: { domains: number; nonexistent: number; unreliable: number; analysed: number };
  /** Counts with percent of `analysed`. */
  spf: Record<string, Stat>;
  dmarc: Record<string, Stat>;
  dkim: Record<string, Stat>;
  mail: Record<string, Stat>;
  senders: Record<string, Stat>;
  dnsHosts: Record<string, Stat>;
  mxProviders: Record<string, Stat>;
  errors: { domainsWithAnyError: number; domainRate: number };
  /** Groups smaller than this are folded into "other (<N)" so rows can't point at individual domains. */
  minCell: number;
}
export interface Stat { count: number; pct: number }

export const MIN_CELL = 5;
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

/** Errors in these fields make a domain's result unreliable; dkim probe errors and partial SPF walks do not. */
export function isUnreliable(r: DomainReport): boolean {
  return r.errors.some(e => /^(txt|dmarc|dmarc-org|mx|ns):/.test(e));
}

function stats(counts: Record<string, number>, base: number): Record<string, Stat> {
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, { count: n, pct: pct(n, base) }]));
}

function table(counts: Map<string, number>, base: number, minCell: number): Record<string, Stat> {
  const out: Record<string, number> = {};
  let other = 0;
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (n < minCell) other += n; else out[k] = n;
  }
  if (other > 0) out[`other (<${minCell})`] = other;
  return stats(out, base);
}

export function aggregate(reports: DomainReport[], now = new Date(), minCell = MIN_CELL): Aggregate {
  const existing = reports.filter(r => r.exists);
  const analysedSet = existing.filter(r => !isUnreliable(r));
  const n = analysedSet.length;
  const c = (pred: (r: DomainReport) => boolean) => analysedSet.filter(pred).length;

  const senders = new Map<string, number>();
  const dns = new Map<string, number>();
  const mx = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of analysedSet) {
    for (const s of r.senders) inc(senders, s);
    inc(dns, r.dnsHost ?? 'unknown');
    inc(mx, r.mx.present ? (r.mx.provider ?? 'other') : 'no MX');
  }
  const withSender = c(r => r.senders.length > 0);

  const withErr = reports.filter(r => r.errors.length > 0).length;
  return {
    generatedAt: now.toISOString(),
    totals: { domains: reports.length, nonexistent: reports.length - existing.length, unreliable: existing.length - n, analysed: n },
    spf: stats({
      missing: c(r => !r.spf.present),
      present: c(r => r.spf.present),
      strict_dash_all: c(r => r.spf.verdict === 'strict'),
      soft_tilde_all: c(r => r.spf.verdict === 'soft'),
      open_or_neutral: c(r => r.spf.verdict === 'open'),
      no_all_mechanism: c(r => r.spf.present && r.spf.verdict === 'missing'),
      over_10_lookups: c(r => !!r.spf.overLimit),
      multiple_records: c(r => !!r.spf.multiple),
    }, n),
    dmarc: stats({
      missing: c(r => !r.dmarc.present),
      present: c(r => r.dmarc.present),
      p_none: c(r => r.dmarc.policy === 'none'),
      p_quarantine: c(r => r.dmarc.policy === 'quarantine'),
      p_reject: c(r => r.dmarc.policy === 'reject'),
      enforcing: c(r => r.dmarc.policy === 'quarantine' || r.dmarc.policy === 'reject'),
      enforcing_full_pct: c(r => (r.dmarc.policy === 'quarantine' || r.dmarc.policy === 'reject') && (r.dmarc.pct ?? 100) >= 100),
      has_rua_reporting: c(r => !!r.dmarc.hasRua),
    }, n),
    dkim: stats({
      found: c(r => r.dkim.found),
      not_found: c(r => !r.dkim.found),
    }, n),
    mail: stats({
      mx_present: c(r => r.mx.present),
      mta_sts: c(r => r.mtaSts),
      no_spf_and_no_dmarc: c(r => !r.spf.present && !r.dmarc.present),
      spf_and_dmarc_and_dkim: c(r => r.spf.present && r.dmarc.present && r.dkim.found),
      sender_detected: withSender,
    }, n),
    senders: table(senders, n, minCell),
    dnsHosts: table(dns, n, minCell),
    mxProviders: table(mx, n, minCell),
    errors: { domainsWithAnyError: withErr, domainRate: pct(withErr, reports.length) },
    minCell,
  };
}
