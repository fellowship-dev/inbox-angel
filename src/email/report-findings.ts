// Adapter: the free check's single DNS lookup (dns-check.ts) -> @inbox-angel/report findings and catalog fixes.
//
// The free check looks up SPF, DMARC, the message's DKIM selector and MX, once, on one resolver. This builds the
// package's DomainReport input from that: SPF and DMARC as observed, MX for mailbox-provider detection, and every other
// check (DKIM selector scan, MTA-STS, BIMI, NS/DNS host) marked not checked. Only SPF and DMARC record findings are
// used: the received message already decides DKIM, and the rest was never looked up. No cross-check is made or claimed.

import {
  detectProviders,
  UNKNOWN_DNS_HOST,
  type DomainReport,
  type SpfAnalysis,
  type SpfIssue,
} from '@inbox-angel/dns-checks';
import { factsOf, fill, findingsOf, type Fix } from '@inbox-angel/report';
import { RECORDS_SEPARATOR, type DnsCheckResult } from './dns-check';

/** The catalog findings a free check can observe: DNS-record problems of SPF and DMARC. */
export const SPF_FINDINGS = ['spf-missing', 'multiple-spf', 'spf-over-10-lookups', 'spf-permerror', 'spf-open', 'spf-no-all'] as const;
export const DMARC_FINDINGS = ['dmarc-missing', 'dmarc-multiple', 'dmarc-invalid', 'dmarc-p-none-no-rua'] as const;
const RECORD_FINDINGS: ReadonlyArray<string> = [...SPF_FINDINGS, ...DMARC_FINDINGS];

const NOT_CHECKED = 'not looked up by the free check';

function spfOf(domain: string, dns: DnsCheckResult): SpfAnalysis {
  const rec = dns.spf;
  const base = { domain, lookupCount: rec?.lookup_count ?? 0, voidLookupCount: 0, voidLimitExceeded: false, issues: [] as SpfIssue[], includes: [] as string[] };
  if (dns.errors?.spf) {
    return { ...base, status: 'temperror', record: null, lookupLimitExceeded: false, issues: [{ code: 'dns-error', domain, message: dns.errors.spf }] };
  }
  if (!rec) return { ...base, status: 'none', record: null, lookupLimitExceeded: false };
  const includes = (rec.terms ?? []).filter(t => (t.name === 'include' || t.name === 'redirect') && t.value).map(t => t.value!);
  const lookupLimitExceeded = base.lookupCount > 10;
  if (!dns.problems?.spf) return { ...base, status: 'ok', record: rec, includes, lookupLimitExceeded };
  const raws = rec.raw.split(RECORDS_SEPARATOR);
  const issues: SpfIssue[] = raws.length > 1
    ? [{ code: 'multiple-records', domain, message: dns.problems.spf }]
    : lookupLimitExceeded ? [{ code: 'lookup-limit', domain, message: dns.problems.spf }] : [];
  return {
    ...base, status: 'permerror', record: raws.length > 1 ? null : rec, includes, lookupLimitExceeded, issues,
    ...(raws.length > 1 ? { rawRecords: raws } : {}),
  };
}

function dmarcOf(domain: string, dns: DnsCheckResult): DomainReport['dmarc'] {
  const base = { domain, inherited: false, organizationalDomain: domain };
  if (dns.errors?.dmarc) return { ...base, status: 'error', record: null, foundAt: null, error: dns.errors.dmarc };
  if (!dns.dmarc) return { ...base, status: 'none', record: null, foundAt: null };
  const foundAt = `_dmarc.${domain}`;
  const raws = dns.dmarc.raw.split(RECORDS_SEPARATOR);
  if (dns.problems?.dmarc && raws.length > 1) return { ...base, status: 'multiple', record: null, foundAt, rawRecords: raws };
  return { ...base, status: 'found', record: dns.dmarc, foundAt };
}

/** The package's input for one free check. `domain` is the sender's domain (the summary's, which `dns.domain` equals in production). */
export function domainReportOf(domain: string, dns: DnsCheckResult): DomainReport {
  const mx = dns.mx ?? { status: 'error' as const, hosts: [], error: NOT_CHECKED };
  const spf = spfOf(domain, dns);
  const notAsset = { url: null, status: 'not-declared' as const };
  return {
    domain,
    mx,
    spf,
    dmarc: dmarcOf(domain, dns),
    dkim: { found: [], errors: [], scanned: 0 },
    mtaSts: { status: 'error', txt: null, policy: null, policyUrl: `https://mta-sts.${domain}/.well-known/mta-sts.txt`, issues: [], error: NOT_CHECKED },
    bimi: { status: 'error', raw: null, foundAt: null, logo: { ...notAsset }, vmc: { ...notAsset, validated: false }, error: NOT_CHECKED },
    providers: detectProviders({ mxHosts: mx.hosts.map(h => h.host), spfIncludes: spf.includes }),
    ns: { status: 'error', hosts: [], error: NOT_CHECKED },
    dnsHost: { ...UNKNOWN_DNS_HOST },
    grade: { level: null, label: 'Not graded', complete: false, reasons: [], nextSteps: [] },
    errors: [
      ...(mx.status === 'error' ? [{ check: 'mx' as const, message: mx.error ?? 'DNS error' }] : []),
      { check: 'dkim', message: NOT_CHECKED }, { check: 'mta-sts', message: NOT_CHECKED },
      { check: 'bimi', message: NOT_CHECKED }, { check: 'ns', message: NOT_CHECKED },
    ],
  };
}

/**
 * Catalog fixes for the SPF and DMARC record findings of one free check, in finding order. Unredacted on purpose:
 * the report goes to the domain's own sender, and the DMARC fixes must keep their real rua= address.
 */
export function recordFixes(domain: string, dns: DnsCheckResult, checkedAt = new Date().toISOString()): Fix[] {
  const report = domainReportOf(domain, dns);
  const facts = factsOf(report, checkedAt);
  return findingsOf(report, checkedAt).filter(f => RECORD_FINDINGS.includes(f.id)).map(f => fill(f, facts));
}
