// The fixed hosted report address: `rua@<INTAKE_DOMAIN>`, the same for every customer.
//
// It carries no token, so the report itself says which domain it is about. Before any allowance, parse or enrichment
// work, the intake reads only `policy_published/domain` from the decompressed XML (a peek with the same 25 MiB cap as
// the full parse), and picks the domain row that owns it: a live, proven domain whose workspace connected reports
// (`rua_address` is this address). From there the path is the token path's: the same per-domain daily allowance, then
// the full parse, which again requires the report's domain to be that domain or one of its subdomains.

import { normalizeDomain, organizationalDomain } from '@inbox-angel/dns-checks';
import { extractReport } from '../dmarc/extract-report';
import { extractAttachmentBytes } from '../email/mime-extract';
import { MAX_REPORT_BYTES } from './config';

export const fixedReportAddress = (intakeDomain: string): string => `rua@${intakeDomain}`;

/** True when `address` is the fixed hosted address of this deployment (any letter case, surrounding space ignored). */
export const isFixedReportAddress = (address: string | null | undefined, intakeDomain: string): boolean =>
  (address ?? '').trim().toLowerCase() === fixedReportAddress(intakeDomain);

/** The report's `policy_published/domain`, read from the attachment without parsing the records. Throws when unreadable. */
export async function peekPolicyDomain(raw: ReadableStream<Uint8Array>): Promise<string | null> {
  const xml = extractReport(await extractAttachmentBytes(raw), { maxBytes: MAX_REPORT_BYTES });
  const m = /<(?:[\w-]+:)?policy_published\b[^>]*>[\s\S]*?<(?:[\w-]+:)?domain\b[^>]*>\s*([^<\s]+)\s*<\/(?:[\w-]+:)?domain>/i.exec(xml);
  return m?.[1] ? normalizeDomain(m[1]) : null;
}

/**
 * The names that may own a report about `domain`: the domain itself, then each parent up to and including its
 * organizational domain, longest first. Never a public suffix, never above the organizational domain.
 */
export function reportDomainCandidates(domain: string): string[] {
  const d = normalizeDomain(domain);
  const org = organizationalDomain(d);
  if (!org || !(d === org || d.endsWith(`.${org}`))) return [];
  const out: string[] = [];
  let name = d;
  for (;;) {
    out.push(name);
    if (name === org) return out;
    name = name.slice(name.indexOf('.') + 1);
  }
}
