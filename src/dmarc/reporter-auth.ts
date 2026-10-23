// Did the report email itself pass DMARC-aligned authentication for the organisation that claims to have sent it?
// Judged from the Authentication-Results header the receiving MTA added. A report that fails (or has no such header)
// is still stored, but flagged: anyone can mail a forged report to a rua address.

import { organizationalDomain } from '@inbox-angel/dns-checks';
import { extractAuthResults } from '../email/parse-headers';
import type { AggregateReport } from './types';

export type ReporterAuth = 'pass' | 'fail' | 'none';
export interface ReporterAuthResult { result: ReporterAuth; domain: string | null }

/** The registrable domain of the reporting organisation: from report_metadata's email, else an org_name that looks like a domain. */
export function reporterOrgDomain(meta: Pick<AggregateReport['report_metadata'], 'org_email' | 'org_name'>): string | null {
  const email = meta.org_email?.trim().toLowerCase();
  const fromEmail = email?.includes('@') ? email.split('@').pop()! : null;
  const name = meta.org_name?.trim().toLowerCase();
  const fromName = name && !name.includes(' ') && name.includes('.') ? name : null;
  for (const c of [fromEmail, fromName]) {
    const org = c ? organizationalDomain(c) : null;
    if (org) return org;
  }
  return null;
}

/** The organisational domain a message authenticated as (an aligned-with-itself dkim/spf/dmarc pass in Authentication-Results), before the report is parsed. Null when nothing passed. */
export function authenticatedReporter(headers: Headers | undefined): string | null {
  const auth = headers ? extractAuthResults(headers) : null;
  if (!auth) return null;
  for (const r of [auth.dkim, auth.spf, auth.dmarc]) {
    const org = r?.result === 'pass' && r.domain ? organizationalDomain(r.domain) : null;
    if (org) return org;
  }
  return null;
}

export function reporterAuth(headers: Headers | undefined, meta: Pick<AggregateReport['report_metadata'], 'org_email' | 'org_name'>): ReporterAuthResult {
  const domain = reporterOrgDomain(meta);
  const auth = headers ? extractAuthResults(headers) : null;
  if (!auth) return { result: 'none', domain };
  if (!domain) return { result: 'fail', domain };

  const aligned = (d: string | null | undefined) => !!d && organizationalDomain(d) === domain;
  const ok =
    (auth.dkim?.result === 'pass' && aligned(auth.dkim.domain)) ||
    (auth.spf?.result === 'pass' && aligned(auth.spf.domain)) ||
    (auth.dmarc?.result === 'pass' && aligned(auth.dmarc.domain));
  return { result: ok ? 'pass' : 'fail', domain };
}
