// Who sent this report mail, and do we recognise them? Decided from the MESSAGE (the carrier), before anything is decompressed or parsed.
// Small exported functions, usable by any intake path (the single-address intake in PR 150 adopts the same ordering and tiers):
//
//   authenticateCarrier(raw, env)     read the topmost authentication header from the raw message and classify the carrier
//   carrierFromHeaders(headers, env)  the same, from headers already read (`readAuthHeaders`)
//   decideTier(carrier, report, env)  after the report's metadata is known: counted / unknown / unauthenticated, and the reporter identity
//   extractReportCapped(bytes, limit) decompress with a hard cap (src/dmarc/extract-report.ts)
//   chargeIntakeCaps(...)             the pre-decompression caps (src/hosted/intake.ts)
//
// CONDITION 1, AUTHENTICATED. The receiver's own results prove the domain of the message's From address:
//   - header: AUTHSERV_HEADER=ar → the TOPMOST `Authentication-Results`; =arc → the topmost `ARC-Authentication-Results` with i=1. Taken from the
//     raw message (`Headers.get` joins duplicates). The other kind is never consulted.
//   - authserv-id: its first token must equal AUTHSERV_ID (case-insensitive); a header the sender added, or one naming another server, is
//     ignored. Until AUTHSERV_ID and AUTHSERV_HEADER are set nothing is authenticated (fail closed). Mail with no authentication results at
//     all is unauthenticated too (cloudflare/workerd#6740 reports Worker-delivered mail without them).
//   - proof: `dkim=pass` (header.d) or `dmarc=pass` (header.from) ALIGNED with the From domain. SPF alone never proves (a shared sending
//     service passes SPF for all its customers). Alignment is RELAXED (same organisational domain), as in DMARC's default: reporters sign and
//     send from subdomains (Yahoo: From noreply@dmarc.yahoo.com, DKIM d=yahoo.com; Microsoft: d=notification.microsoft.com, From microsoft.com).
//   - the From header must hold exactly one address.
// CONDITION 2, REGISTRY (src/dmarc/known-reporters.ts): the passing DKIM organisation, the From address and the report's own
// report_metadata/email together match one entry. org_name, Submitter and subject never decide anything.

import { organizationalDomain } from '@ready-set-mail/dns-checks';
import { authProof, parseAuthResults } from '../email/parse-headers';
import { readAuthHeaders, selectTrusted, type AuthHeaders } from '../email/sender-proof';
import { registryCandidates, reportEmailAccepted, type KnownReporter, type RegistryEnv } from './known-reporters';

export type ReporterTier = 'counted' | 'unknown' | 'unauthenticated';

/** Why a carrier is not authenticated (also the reason codes in src/hosted/reasons.ts). */
export type AuthFailure = 'authserv_unconfigured' | 'no_authentication_results' | 'authserv_id_not_found' | 'authres_malformed' | 'authres_too_long' | 'authres_version_unsupported' | 'from_invalid' | 'not_authenticated';

/** What the inbound mail carried, for the instance-wide auth status (`intakeAuthStatus`). */
export type AuthPresence = 'unconfigured' | 'absent' | 'foreign' | 'present';

export type CarrierClass = 'registry' | 'authenticated' | 'unauthenticated';

export interface AuthservEnv extends RegistryEnv {
  AUTHSERV_ID?: string;
  AUTHSERV_HEADER?: string;
}

export interface Carrier {
  class: CarrierClass;
  authenticated: boolean;
  reason: AuthFailure | null;
  presence: AuthPresence;
  /** The single From address, lowercase; null when absent or not exactly one. */
  from: string | null;
  /** Organisational domain of the From address. */
  fromOrg: string | null;
  /** Organisational domain of the passing DKIM signature (any pass), null when none. */
  dkimOrg: string | null;
  via: 'dkim' | 'dmarc' | null;
  /** Registry entries matching the DKIM organisation and From address (empty unless authenticated). */
  candidates: KnownReporter[];
  /** Why the results header could not be read (tokenizer detail), for the log; never shown to the sender. */
  detail?: string;
}

const org = (d: string | null | undefined): string | null => (d ? (organizationalDomain(d) ?? d.toLowerCase()) : null);
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** Classify the carrier from the headers already read. */
export function carrierFromHeaders(headers: AuthHeaders | undefined, env: AuthservEnv): Carrier {
  const from = headers?.from ?? null;
  const fromOrg = from ? org(domainOf(from)) : null;
  const base = { from, fromOrg, dkimOrg: null as string | null, via: null as Carrier['via'], candidates: [] as KnownReporter[] };
  const fail = (reason: AuthFailure, presence: AuthPresence, extra: Partial<Carrier> = {}): Carrier => ({ class: 'unauthenticated', authenticated: false, reason, presence, ...base, ...extra });
  const mode = env.AUTHSERV_HEADER?.trim().toLowerCase();
  if (!env.AUTHSERV_ID?.trim() || (mode !== 'ar' && mode !== 'arc')) return fail('authserv_unconfigured', 'unconfigured');
  if (!headers || !(mode === 'ar' ? headers.ar : headers.arc)) return fail('no_authentication_results', 'absent');
  const sel = selectTrusted(headers, env.AUTHSERV_ID, mode);
  if (sel.kind === 'foreign') return fail('authserv_id_not_found', 'foreign');
  // The header could not be tokenized cleanly (RFC 8601, src/email/auth-results.ts): nothing in it is believed.
  if (sel.kind === 'malformed') return fail(sel.failure === 'too_long' ? 'authres_too_long' : sel.failure === 'unsupported_version' ? 'authres_version_unsupported' : 'authres_malformed', 'present', { detail: sel.detail });
  const parsed = parseAuthResults(sel.value);
  // A receiver writes one dkim result per DKIM-Signature it verified, and one dmarc result per message. More dkim results (other than
  // "none") than the message has signatures, or more than one dmarc result, means part of the header was not written by the receiver: a
  // sender-chosen value copied back unquoted (smtp.helo=x;dkim=pass(c)header.d=google.com). Nothing in it is believed.
  const dkimResults = parsed?.dkimAll.filter((d) => d.result !== 'none').length ?? 0;
  if ((headers.dkimSignatures !== undefined && dkimResults > headers.dkimSignatures) || (parsed?.dmarcAll.length ?? 0) > 1) {
    return fail('authres_malformed', 'present', { detail: `${dkimResults} dkim results for ${headers.dkimSignatures ?? '?'} signatures, ${parsed?.dmarcAll.length ?? 0} dmarc results` });
  }
  const proof = authProof(parsed);
  // EVERY dkim=pass counts (a message can carry several signatures); the one aligned with the From organisation wins, else the first passing one.
  const dkimOrg = fromOrg && proof.dkimPassOrgs.includes(fromOrg) ? fromOrg : proof.dkimPassOrgs[0] ?? null;
  if (!from || !fromOrg) return fail('from_invalid', 'present', { dkimOrg });
  const via: Carrier['via'] = proof.dkimAligned(fromOrg) ? 'dkim' : proof.dmarcAligned(fromOrg) ? 'dmarc' : null;
  if (!via) return fail('not_authenticated', 'present', { dkimOrg });
  const candidates = registryCandidates(dkimOrg, from, env);
  return { class: candidates.length ? 'registry' : 'authenticated', authenticated: true, reason: null, presence: 'present', from, fromOrg, dkimOrg, via, candidates };
}

/**
 * An envelope sender the receiver may have copied unquoted into its own results header (`smtp.mailfrom=`): a ";" there starts a new
 * resinfo the receiver never wrote ("x;dkim=pass header.d=google.com;arc=none smtp.x=y@attacker.example"), which no tokenizer can tell
 * from a real one. A sender whose envelope address holds anything outside an unquoted dot-atom address (";", spaces, quotes,
 * parentheses, backslashes, commas or control characters) is therefore not believed: the carrier is unauthenticated, reason
 * `authres_malformed`. Real reporters' envelope senders are plain addresses. The null sender (empty) is safe.
 */
export function envelopeIsPlain(envelopeFrom: string | null | undefined): boolean {
  return !envelopeFrom || /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]+$/.test(envelopeFrom);
}

export function guardEnvelope(carrier: Carrier, envelopeFrom: string | null | undefined): Carrier {
  if (envelopeIsPlain(envelopeFrom) || !carrier.authenticated) return carrier;
  return { ...carrier, class: 'unauthenticated', authenticated: false, reason: 'authres_malformed', via: null, candidates: [], detail: 'envelope sender is not a plain address' };
}

/** Classify the carrier of a raw message: reads (and cancels) a stream of its headers, then `carrierFromHeaders`. */
export async function authenticateCarrier(raw: ReadableStream<Uint8Array> | null | undefined, env: AuthservEnv): Promise<{ carrier: Carrier; headers: AuthHeaders }> {
  const headers = await readAuthHeaders(raw);
  return { carrier: carrierFromHeaders(headers, env), headers };
}

export interface TierDecision {
  tier: ReporterTier;
  /** The registry id, else the authenticated organisational domain, else '~unauth'. Also the dedup namespace of the report id. */
  identity: string;
  /** The registry entry's label for a counted report. */
  knownAs: string | null;
  /** Did report_metadata/email match the matching registry entry's accepted set (null: no entry matched the carrier)? */
  emailMatched: boolean | null;
  /** Why the report is not counted (null when counted). */
  reason: 'registry_email_not_accepted' | 'not_in_registry' | 'inconsistent_identity' | AuthFailure | null;
  /** Stored value for reporter_auth: pass | fail | none. */
  auth: 'pass' | 'fail' | 'none';
}

export const UNAUTH_IDENTITY = '~unauth';

/**
 * After the report's metadata is known (and before IP enrichment): what is this report?
 *   counted          carrier authenticated AND matches a registry entry AND report_metadata/email is in that entry's accepted set
 *   unknown          carrier authenticated and self-consistent (DKIM organisation = From organisation, and the report email's organisation is
 *                    one of them) but not in the registry; or a registry carrier whose report email is not in the accepted set (a changed
 *                    identity: stored and visible, not counted: drift is never silently trusted)
 *   unauthenticated  everything else
 */
export function decideTier(carrier: Carrier, report: { email?: string | null }): TierDecision {
  const auth: TierDecision['auth'] = carrier.authenticated ? 'pass' : carrier.reason === 'authserv_unconfigured' || carrier.reason === 'no_authentication_results' ? 'none' : 'fail';
  if (!carrier.authenticated) return { tier: 'unauthenticated', identity: UNAUTH_IDENTITY, knownAs: null, emailMatched: null, reason: carrier.reason, auth };
  const entry = carrier.candidates.find((e) => reportEmailAccepted(e, report.email));
  if (entry) return { tier: 'counted', identity: entry.id, knownAs: entry.label, emailMatched: true, reason: null, auth };
  if (carrier.candidates.length) return { tier: 'unknown', identity: carrier.candidates[0].id, knownAs: null, emailMatched: false, reason: 'registry_email_not_accepted', auth };
  const identityOrg = carrier.dkimOrg ?? (carrier.via === 'dmarc' ? carrier.fromOrg : null);
  const emailOrg = report.email?.includes('@') ? org(domainOf(report.email.trim().toLowerCase())) : null;
  if (identityOrg && identityOrg === carrier.fromOrg && emailOrg && (emailOrg === identityOrg || emailOrg === carrier.fromOrg)) {
    return { tier: 'unknown', identity: identityOrg, knownAs: null, emailMatched: null, reason: 'not_in_registry', auth };
  }
  return { tier: 'unauthenticated', identity: UNAUTH_IDENTITY, knownAs: null, emailMatched: null, reason: 'inconsistent_identity', auth: 'fail' };
}

/** Stored with the report (src/dmarc/store-report.ts). */
export interface ReporterInfo {
  tier: ReporterTier;
  identity: string;
  knownAs: string | null;
  /** The authenticated sending organisation (DKIM), null when unauthenticated. */
  domain: string | null;
  auth: 'pass' | 'fail' | 'none';
  reason: string | null;
}

export function reporterInfo(carrier: Carrier, d: TierDecision): ReporterInfo {
  return { tier: d.tier, identity: d.identity, knownAs: d.knownAs, domain: carrier.authenticated ? (carrier.dkimOrg ?? carrier.fromOrg) : null, auth: d.auth, reason: d.reason };
}
