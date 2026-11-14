// Who sent this report mail, and do we recognise them? Two separate conditions, decided from the MESSAGE, before the report is read.
//
// 1. AUTHENTICATED (this file, `authenticateSender`). The receiver's own results prove the From domain:
//      - header: AUTHSERV_HEADER=ar  → the TOPMOST `Authentication-Results`;  =arc → the topmost `ARC-Authentication-Results` with i=1.
//        Taken from the raw message (`Headers.get` joins duplicates). The other kind is never consulted.
//      - authserv-id: its first token must equal AUTHSERV_ID (case-insensitive). A header the sender added, or one naming another
//        server, is ignored. Until AUTHSERV_ID and AUTHSERV_HEADER are set, nothing is authenticated (fail closed).
//      - proof: dkim=pass (header.d), spf=pass (smtp.mailfrom) or dmarc=pass (header.from) whose domain is ALIGNED with the domain of the
//        message's From header. Alignment is RELAXED (same organisational domain), as in DMARC's default: reporters sign and send from
//        subdomains of their own domain (Yahoo sends From noreply@dmarc.yahoo.com with DKIM d=yahoo.com), which strict alignment would
//        refuse. It still means the sender controls the From domain: nobody else can produce a DKIM/SPF pass for it.
//      - the From header must hold exactly one address (src/email/sender-proof.ts `singleAddress`).
// 2. KNOWN (src/dmarc/known-reporters.ts). The authenticated From identity is matched against the maintained list. The report's own
//    org_name/email are never used: they are text the sender wrote, and a known name inside the XML must not help.
//
// The result is a tier: 'counted' (authenticated AND known), 'unknown' (authenticated, not known: stored, not counted) or refused
// (not authenticated). Self-host may keep unauthenticated mail as 'unauthenticated' instead of refusing it (INTAKE_UNAUTHENTICATED).

import { organizationalDomain } from '@inbox-angel/dns-checks';
import { parseAuthResults } from '../email/parse-headers';
import { trustedResults, type AuthHeaders } from '../email/sender-proof';
import { getMode } from '../tenancy/mode';
import { matchKnownReporter, type KnownReporterEnv } from './known-reporters';

export { SHARED_MAILBOX_DOMAINS } from './known-reporters';

export type ReporterTier = 'counted' | 'unknown' | 'unauthenticated';

/** Why a message is not authenticated (a reason code, src/hosted/reasons.ts). */
export type AuthFailure = 'authserv_unconfigured' | 'no_authentication_results' | 'authserv_id_not_found' | 'from_invalid' | 'not_authenticated';

export interface AuthservEnv extends KnownReporterEnv {
  MODE?: string;
  AUTHSERV_ID?: string;
  AUTHSERV_HEADER?: string;
  /** `refuse` | `store`: what to do with mail that is not authenticated. Hosted: always refused. Self-host default: store (see docs). */
  INTAKE_UNAUTHENTICATED?: string;
}

export type SenderAuth =
  | { authenticated: true; from: string; domain: string; via: 'dkim' | 'spf' | 'dmarc' }
  | { authenticated: false; reason: AuthFailure; from: string | null };

const org = (d: string | null | undefined) => (d ? (organizationalDomain(d) ?? d.toLowerCase()) : null);
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** Condition 1: did the receiver authenticate the domain of the message's From address? */
export function authenticateSender(headers: AuthHeaders | undefined, env: Pick<AuthservEnv, 'AUTHSERV_ID' | 'AUTHSERV_HEADER'>): SenderAuth {
  const from = headers?.from ?? null;
  const mode = env.AUTHSERV_HEADER?.trim().toLowerCase();
  if (!env.AUTHSERV_ID?.trim() || (mode !== 'ar' && mode !== 'arc')) return { authenticated: false, reason: 'authserv_unconfigured', from };
  if (!headers || (!headers.ar && !headers.arc) || !(mode === 'ar' ? headers.ar : headers.arc)) return { authenticated: false, reason: 'no_authentication_results', from };
  const trusted = trustedResults(headers, env.AUTHSERV_ID, mode);
  if (!trusted) return { authenticated: false, reason: 'authserv_id_not_found', from };
  if (!from) return { authenticated: false, reason: 'from_invalid', from };
  const fromOrg = org(domainOf(from));
  const auth = parseAuthResults(trusted);
  if (!auth || !fromOrg) return { authenticated: false, reason: 'not_authenticated', from };
  const aligned = (d: string | null | undefined) => org(d) === fromOrg;
  const via = auth.dkim?.result === 'pass' && aligned(auth.dkim.domain) ? 'dkim'
    : auth.dmarc?.result === 'pass' && aligned(auth.dmarc.domain) ? 'dmarc'
    : auth.spf?.result === 'pass' && aligned(auth.spf.domain) ? 'spf' : null;
  return via ? { authenticated: true, from, domain: fromOrg, via } : { authenticated: false, reason: 'not_authenticated', from };
}

export type Decision =
  | { action: 'refuse'; reason: AuthFailure }
  | { action: 'accept'; tier: ReporterTier; /** The authenticated sending domain (organisational), null when not authenticated. */ domain: string | null; knownAs: string | null; auth: 'pass' | 'fail' | 'none'; reason: AuthFailure | null };

/** Hosted always refuses unauthenticated mail; self-host keeps it as 'unauthenticated' unless INTAKE_UNAUTHENTICATED=refuse. */
export function refusesUnauthenticated(env: Pick<AuthservEnv, 'MODE' | 'INTAKE_UNAUTHENTICATED'>): boolean {
  if (getMode(env) === 'saas') return true;
  return env.INTAKE_UNAUTHENTICATED?.trim().toLowerCase() === 'refuse';
}

/** Conditions 1 and 2 for one message: refuse it, or accept it with its tier. */
export function classifySender(headers: AuthHeaders | undefined, env: AuthservEnv): Decision {
  const auth = authenticateSender(headers, env);
  if (!auth.authenticated) {
    if (refusesUnauthenticated(env)) return { action: 'refuse', reason: auth.reason };
    return { action: 'accept', tier: 'unauthenticated', domain: null, knownAs: null, auth: auth.reason === 'authserv_unconfigured' || auth.reason === 'no_authentication_results' ? 'none' : 'fail', reason: auth.reason };
  }
  const known = matchKnownReporter(auth.from, env);
  return { action: 'accept', tier: known ? 'counted' : 'unknown', domain: auth.domain, knownAs: known?.org ?? null, auth: 'pass', reason: null };
}
