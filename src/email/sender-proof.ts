// Did the sender of an inbound email really control the domain of its address?
//
// Enrolment in the onboarding sequence is mail to that address, so it needs a proof the sender cannot forge. It fails closed:
//   - AUTHSERV_ID (the authserv-id of the receiving server's own results) must be configured, or nobody is enrolled. Nothing
//     guarantees that the receiver prepends a plain Authentication-Results header; it may add only ARC-Authentication-Results.
//     Until an operator has looked at one routed message and set AUTHSERV_ID (docs/email-funnel.md), the report is still
//     sent but the sender is not enrolled.
//   - Only the TOPMOST header of the kind is read (a header the sender adds sits below the receiver's), from the raw
//     message: `Headers.get` joins duplicates. Its authserv-id must equal AUTHSERV_ID.
//   - AUTHSERV_HEADER (`ar` | `arc`) must be configured too, and names the ONE kind of header trusted: the plain
//     Authentication-Results, or the topmost ARC-Authentication-Results with i=1. If both kinds were trusted, the sender
//     could forge whichever kind the receiver does not add, using our (guessable) authserv-id.
//   - The results must show a DKIM pass aligned with the address's domain, or a DMARC pass for it. SPF alone proves little
//     (a shared sending service passes it for anyone), and a DMARC pass for the From header says nothing about the
//     envelope sender.

import { domainOfValue, tokenizeAuthResults, type AuthResultsFailure } from './auth-results';
import { authProof, parseAuthResults } from './parse-headers';

const MAX_HEADER_BYTES = 128 * 1024;

export interface AuthHeaders {
  /** Value of the topmost Authentication-Results header, unfolded. */
  ar: string | null;
  /** Value of the topmost ARC-Authentication-Results header, unfolded (starts with `i=N;`). */
  arc: string | null;
  /** The From header's single address, lowercased; null when the message has no From, more than one, or an address list. */
  from?: string | null;
  /** How many DKIM-Signature header fields the message carries (set by readAuthHeaders; undefined: not read, nothing checked against it). */
  dkimSignatures?: number;
}

/** The one address in a From header value (`Name <a@b.c>` or `a@b.c`), lowercased, or null when it is not exactly one address. */
export function singleAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = value.replace(/"(?:\\.|[^"\\])*"/g, '').replace(/\([^)]*\)/g, '');
  const angle = [...bare.matchAll(/<([^<>]*)>/g)];
  if (angle.length > 1 || bare.includes(',') || bare.includes(';')) return null;
  const addr = (angle.length === 1 ? angle[0][1] : bare).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr) ? addr : null;
}

/** The topmost Authentication-Results and ARC-Authentication-Results of a raw message. Nulls if absent or unreadable. */
export async function readAuthHeaders(raw: ReadableStream<Uint8Array> | null | undefined): Promise<AuthHeaders> {
  const none: AuthHeaders = { ar: null, arc: null };
  if (!raw) return none;
  const reader = raw.getReader();
  let bytes = new Uint8Array(0);
  let text = '';
  try {
    while (bytes.length < MAX_HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const next = new Uint8Array(bytes.length + value.length);
      next.set(bytes);
      next.set(value, bytes.length);
      bytes = next;
      text = new TextDecoder('latin1').decode(bytes);
      if (/\r?\n\r?\n/.test(text)) break;
    }
  } catch {
    return none;
  } finally {
    reader.cancel().catch(() => {});
  }
  const block = text.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const out: AuthHeaders = { ar: null, arc: null, from: null, dkimSignatures: 0 };
  let froms = 0;
  for (const line of block.split(/\r?\n/)) {
    if (/^dkim-signature:/i.test(line)) out.dkimSignatures = (out.dkimSignatures ?? 0) + 1;
    const from = line.match(/^from:\s*(.*)$/i);
    if (from && ++froms === 1) out.from = singleAddress(from[1]);
    const ar = line.match(/^authentication-results:\s*(.*)$/i);
    if (ar && out.ar === null) out.ar = ar[1];
    const arc = line.match(/^arc-authentication-results:\s*(.*)$/i);
    if (arc && out.arc === null) out.arc = arc[1];
  }
  if (froms > 1) out.from = null; // two From headers: the one DMARC judged is not knowable
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/** True when a DKIM pass aligned with `addressDomain`, or a DMARC pass for it, is in `results` (a header value, authserv-id first). Any dkim=pass counts, not only the last. */
export function provesDomain(results: string | null, addressDomain: string): boolean {
  if (!results) return false;
  const proof = authProof(parseAuthResults(results));
  return proof.dkimAligned(addressDomain) || proof.dmarcAligned(addressDomain);
}

export type SenderProof = { ok: true; via: 'ar' | 'arc' } | { ok: false; reason: string };

/** Which header of the configured kind, if any, is the receiver's: its value (authserv-id first), foreign (names another server / none), or unreadable. */
export type TrustedSelection = { kind: 'ok'; value: string } | { kind: 'foreign' } | { kind: 'malformed'; failure: AuthResultsFailure; detail: string };

export function selectTrusted(headers: AuthHeaders, authservId: string | undefined, only: string | undefined): TrustedSelection {
  const mode = only?.trim().toLowerCase();
  const want = authservId?.trim() ? norm(authservId) : null;
  let value: string | null = null;
  if (mode === 'ar') value = headers.ar;
  else if (mode === 'arc' && headers.arc) {
    // ARC-Authentication-Results: i=N; authserv-id; resinfo ... Only instance 1 is the receiver's own.
    const hop = headers.arc.match(/^\s*i\s*=\s*1\s*;/i);
    value = hop ? headers.arc.slice(hop[0].length) : null;
  }
  if (!want || !value) return { kind: 'foreign' };
  const t = tokenizeAuthResults(value);
  if (!t.ok) return { kind: 'malformed', failure: t.failure, detail: t.detail };
  return norm(t.authservId) === want ? { kind: 'ok', value } : { kind: 'foreign' };
}

/**
 * The receiver's own results, as one header value with the authserv-id first, or null when AUTHSERV_ID / AUTHSERV_HEADER
 * are not configured, no header of the configured kind names AUTHSERV_ID, or the header cannot be tokenized (the rules at the top of this file).
 */
export function trustedResults(headers: AuthHeaders, authservId: string | undefined, only: string | undefined): string | null {
  const sel = selectTrusted(headers, authservId, only);
  return sel.kind === 'ok' ? sel.value : null;
}
/** Decide whether the sender proved `addressDomain`. Fails closed, with the reason (for the log; it never names the sender). */
export function proveSender(headers: AuthHeaders, addressDomain: string, authservId: string | undefined, only: string | undefined): SenderProof {
  if (!authservId?.trim()) return { ok: false, reason: 'AUTHSERV_ID is not set' };
  const mode = only?.trim().toLowerCase();
  if (mode !== 'ar' && mode !== 'arc') return { ok: false, reason: 'AUTHSERV_HEADER is not set' };
  const trusted = trustedResults(headers, authservId, mode);
  if (trusted) {
    return provesDomain(trusted, addressDomain)
      ? { ok: true, via: mode }
      : { ok: false, reason: mode === 'ar' ? 'the receiver\'s results do not show an aligned DKIM pass or a DMARC pass' : 'the receiver\'s ARC results do not show an aligned DKIM pass or a DMARC pass' };
  }
  return { ok: false, reason: headers.ar || headers.arc ? 'no Authentication-Results (or ARC i=1) header names the configured AUTHSERV_ID' : 'the message has no Authentication-Results header' };
}

/**
 * True when the receiver's own results (`trusted`, from trustedResults) show spf=pass for an smtp.mailfrom on exactly the
 * envelope sender's domain: the sending server was allowed to use that address as its return path. Weaker than
 * proveSender (a shared sending service passes SPF for all its customers), but enough to send that address one reply.
 */
export function spfPassesFor(trusted: string | null, envelopeDomain: string): boolean {
  if (!trusted) return false;
  const t = tokenizeAuthResults(trusted);
  if (!t.ok) return false;
  // Fail closed unless there is exactly one spf result.
  const spf = t.results.filter((r) => r.method === 'spf');
  if (spf.length !== 1 || spf[0].result !== 'pass') return false;
  const mailfrom = domainOfValue(spf[0].props['smtp.mailfrom']);
  return !!mailfrom && mailfrom === norm(envelopeDomain);
}
