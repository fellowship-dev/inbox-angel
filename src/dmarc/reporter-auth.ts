// Did the report email itself pass DMARC-aligned authentication for the organisation that claims to have sent it?
// Judged from the Authentication-Results header the receiving MTA added. A report that fails (or has no such header)
// is still stored, but flagged: anyone can mail a forged report to a rua address.

import { organizationalDomain } from '@inbox-angel/dns-checks';
import { parseAuthResults } from '../email/parse-headers';
import { proveSender, type AuthHeaders } from '../email/sender-proof';
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

export interface AuthservEnv { AUTHSERV_ID?: string; AUTHSERV_HEADER?: string }

/**
 * The organisational domain the message proved to the receiver (an aligned DKIM pass or a DMARC pass in the TOPMOST
 * results header naming our AUTHSERV_ID: src/email/sender-proof.ts), decided before the report is parsed. Null when
 * the env is unset, nothing is proven, or the header is not the receiver's: such a message is unproven.
 */
export function provenReporter(headers: AuthHeaders, env: AuthservEnv): string | null {
  if (!env.AUTHSERV_ID || !env.AUTHSERV_HEADER) return null;
  const candidates = new Set<string>();
  for (const value of [headers.ar, headers.arc ? headers.arc.split(';').slice(1).join(';') : null]) {
    const auth = value ? parseAuthResults(value) : null;
    for (const r of [auth?.dkim, auth?.dmarc]) {
      const org = r?.result === 'pass' && r.domain ? organizationalDomain(r.domain) : null;
      if (org) candidates.add(org);
    }
  }
  for (const c of candidates) if (proveSender(headers, c, env.AUTHSERV_ID, env.AUTHSERV_HEADER).ok) return c;
  return null;
}

/** The sender domain an unproven message claims (SMTP envelope sender), as a bucket key. Forgeable: it only spreads the allowance. */
export function claimedSender(from: string | undefined): string {
  const host = from?.split('@').pop()?.trim().toLowerCase();
  return '~' + ((host && organizationalDomain(host)) || '');
}

/**
 * Did the report email prove, to the receiver, the organisation its report claims to come from?
 *  pass  an aligned DKIM pass or a DMARC pass for the reporter's organisational domain in the receiver's own header
 *  fail  the receiver's results are there but do not prove it, or name another server
 *  none  nothing to go on: no results header, or AUTHSERV_ID / AUTHSERV_HEADER are not configured (fail closed)
 */
export function reporterAuth(headers: AuthHeaders | undefined, meta: Pick<AggregateReport['report_metadata'], 'org_email' | 'org_name'>, env: AuthservEnv): ReporterAuthResult {
  const domain = reporterOrgDomain(meta);
  if (!headers || !env.AUTHSERV_ID || !env.AUTHSERV_HEADER || (!headers.ar && !headers.arc)) return { result: 'none', domain };
  if (!domain) return { result: 'fail', domain };
  return { result: proveSender(headers, domain, env.AUTHSERV_ID, env.AUTHSERV_HEADER).ok ? 'pass' : 'fail', domain };
}
