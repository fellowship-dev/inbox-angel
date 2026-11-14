// Did the report email itself pass DMARC-aligned authentication for the organisation that claims to have sent it?
// Judged from the Authentication-Results header the receiving MTA added. A report that fails (or has no such header)
// is still stored, but flagged: anyone can mail a forged report to a rua address.

import { organizationalDomain } from '@inbox-angel/dns-checks';
import { parseAuthResults } from '../email/parse-headers';
import { proveSender, type AuthHeaders } from '../email/sender-proof';
import type { AggregateReport } from './types';

export type ReporterAuth = 'pass' | 'fail' | 'none';
/** Why a report is not proven (null when it is). Shown to the owner and logged. */
export type ReporterAuthReason =
  | 'authserv_not_configured' | 'no_results_header' | 'no_reporter_domain' | 'org_mismatch'
  | 'authserv_id_not_found' | 'not_aligned' | 'shared_mailbox_domain';
export interface ReporterAuthResult { result: ReporterAuth; domain: string | null; reason: ReporterAuthReason | null }

/**
 * Organisations whose domain anyone can send authenticated mail from: free-mailbox providers and shared sending services. A DKIM
 * pass for `d=yahoo.com` proves "a Yahoo mailbox sent this", not "Yahoo's reporting system did", so for these domains a pass proves
 * the reporter only when the message's From address is exactly a known report-sender address (below). Listed by organisational domain.
 */
export const SHARED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  'yahoo.com', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com', 'aol.com', 'aim.com', 'verizon.net', 'att.net', 'sbcglobal.net', 'comcast.net',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com',
  'gmx.net', 'gmx.de', 'gmx.com', 'web.de', 'mail.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'yandex.ru', 'yandex.com', 'yandex.net', 'ya.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net', 'hanmail.net', 'seznam.cz', 'proton.me', 'protonmail.com', 'pm.me',
  'zoho.com', 'zohomail.com', 'fastmail.com', 'fastmail.fm', 'hey.com', 'tutanota.com', 'tuta.io',
  'amazonses.com', 'sendgrid.net', 'mailgun.org', 'mandrillapp.com', 'postmarkapp.com', 'sparkpostmail.com', 'mailchimp.com',
]);

/**
 * Exact From addresses, for the shared-mailbox domains above, known to be an aggregate-report sender. Deliberately empty: no
 * provider documents the From address of its report mail with enough certainty to ship here (google.com and microsoft.com are not
 * shared-mailbox domains and need no entry). An operator adds the ones seen on real report mail with
 * INTAKE_TRUSTED_REPORTER_ADDRESSES (docs/hosted.md); until then such a reporter is stored but not counted.
 */
export const BUILT_IN_REPORT_SENDERS: readonly string[] = [];

export interface AuthservEnv { AUTHSERV_ID?: string; AUTHSERV_HEADER?: string; INTAKE_TRUSTED_REPORTER_ADDRESSES?: string }

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** The trusted report-sender addresses: the built-in ones and INTAKE_TRUSTED_REPORTER_ADDRESSES (comma or space separated). */
export function trustedSenderAddresses(env: Pick<AuthservEnv, 'INTAKE_TRUSTED_REPORTER_ADDRESSES'>): Set<string> {
  const fromEnv = (env.INTAKE_TRUSTED_REPORTER_ADDRESSES ?? '').split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+$/.test(a));
  return new Set([...BUILT_IN_REPORT_SENDERS, ...fromEnv]);
}

/**
 * May the authenticated organisation `org` be taken as the reporter? Always, unless it is a shared-mailbox domain: then only when the
 * message's From address is exactly a trusted report-sender address of that organisation. (A mailbox on yahoo.com cannot send as
 * another Yahoo address: the provider's own authentication ties the From address to the account.)
 */
export function mayBeReporter(org: string, headers: AuthHeaders, env: AuthservEnv): boolean {
  if (!SHARED_MAILBOX_DOMAINS.has(org)) return true;
  const from = headers.from;
  return !!from && trustedSenderAddresses(env).has(from) && organizationalDomain(domainOf(from)) === org;
}

/** The registrable domains the report names as its author: from report_metadata's email, and from an org_name that looks like a domain. */
function namedDomains(meta: Pick<AggregateReport['report_metadata'], 'org_email' | 'org_name'>): { email: string | null; name: string | null } {
  const email = meta.org_email?.trim().toLowerCase();
  const fromEmail = email?.includes('@') ? email.split('@').pop()! : null;
  const name = meta.org_name?.trim().toLowerCase();
  const fromName = name && !name.includes(' ') && name.includes('.') ? name : null;
  return { email: fromEmail ? organizationalDomain(fromEmail) : null, name: fromName ? organizationalDomain(fromName) : null };
}

/** The registrable domain of the reporting organisation: from report_metadata's email, else an org_name that looks like a domain. */
export function reporterOrgDomain(meta: Pick<AggregateReport['report_metadata'], 'org_email' | 'org_name'>): string | null {
  const n = namedDomains(meta);
  return n.email ?? n.name;
}

/**
 * The organisational domain the message proved to the receiver (an aligned DKIM pass or a DMARC pass in the TOPMOST
 * results header naming our AUTHSERV_ID: src/email/sender-proof.ts), decided before the report is parsed. Null when
 * the env is unset, nothing is proven, the header is not the receiver's, or the domain is a shared-mailbox domain without a
 * trusted From address: such a message is unproven.
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
  for (const c of candidates) if (mayBeReporter(c, headers, env) && proveSender(headers, c, env.AUTHSERV_ID, env.AUTHSERV_HEADER).ok) return c;
  return null;
}

/** The sender domain an unproven message claims (SMTP envelope sender), as a bucket key. Forgeable: it only spreads the allowance. */
export function claimedSender(from: string | undefined): string {
  const host = from?.split('@').pop()?.trim().toLowerCase();
  return '~' + ((host && organizationalDomain(host)) || '');
}

/**
 * Did the report email prove, to the receiver, the organisation its report claims to come from?
 *  pass  an aligned DKIM pass or a DMARC pass for the reporter's organisational domain in the receiver's own header, and the
 *        reporter domain is not a shared-mailbox domain (or the From address is a trusted report sender)
 *  fail  the receiver's results are there but do not prove it, or name another server, or the report names two different organisations
 *  none  nothing to go on: no results header, or AUTHSERV_ID / AUTHSERV_HEADER are not configured (fail closed)
 * `reason` says which. The reporter domain comes from the REPORT (its `email`, else a domain-shaped `org_name`), never from the mail:
 * a forger who authenticates as her own domain is proven as that domain, not as google.com.
 */
export function reporterAuth(headers: AuthHeaders | undefined, meta: Pick<AggregateReport['report_metadata'], 'org_email' | 'org_name'>, env: AuthservEnv): ReporterAuthResult {
  const named = namedDomains(meta);
  const domain = named.email ?? named.name;
  if (!env.AUTHSERV_ID || !env.AUTHSERV_HEADER) return { result: 'none', domain, reason: 'authserv_not_configured' };
  if (!headers || (!headers.ar && !headers.arc)) return { result: 'none', domain, reason: 'no_results_header' };
  if (!domain) return { result: 'fail', domain, reason: 'no_reporter_domain' };
  // Two named organisations that disagree: the report is not clearly from one reporter.
  if (named.email && named.name && named.email !== named.name) return { result: 'fail', domain, reason: 'org_mismatch' };
  const proof = proveSender(headers, domain, env.AUTHSERV_ID, env.AUTHSERV_HEADER);
  if (!proof.ok) return { result: 'fail', domain, reason: /names the configured AUTHSERV_ID/.test(proof.reason) ? 'authserv_id_not_found' : 'not_aligned' };
  if (!mayBeReporter(domain, headers, env)) return { result: 'fail', domain, reason: 'shared_mailbox_domain' };
  return { result: 'pass', domain, reason: null };
}
