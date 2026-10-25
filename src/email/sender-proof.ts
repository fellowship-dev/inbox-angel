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

import { organizationalDomain } from '@inbox-angel/dns-checks';
import { parseAuthResults } from './parse-headers';

const MAX_HEADER_BYTES = 128 * 1024;

export interface AuthHeaders {
  /** Value of the topmost Authentication-Results header, unfolded. */
  ar: string | null;
  /** Value of the topmost ARC-Authentication-Results header, unfolded (starts with `i=N;`). */
  arc: string | null;
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
  const out: AuthHeaders = { ar: null, arc: null };
  for (const line of block.split(/\r?\n/)) {
    const ar = line.match(/^authentication-results:\s*(.*)$/i);
    if (ar && out.ar === null) out.ar = ar[1];
    const arc = line.match(/^arc-authentication-results:\s*(.*)$/i);
    if (arc && out.arc === null) out.arc = arc[1];
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/** True when a DKIM pass aligned with `addressDomain`, or a DMARC pass for it, is in `results` (a header value, authserv-id first). */
export function provesDomain(results: string | null, addressDomain: string): boolean {
  if (!results) return false;
  const auth = parseAuthResults(results);
  const org = (d: string | null | undefined) => (d ? organizationalDomain(d) ?? d.toLowerCase() : null);
  const target = org(addressDomain);
  if (!auth || !target) return false;
  return (auth.dkim?.result === 'pass' && org(auth.dkim.domain) === target) || (auth.dmarc?.result === 'pass' && org(auth.dmarc.domain) === target);
}

export type SenderProof = { ok: true; via: 'ar' | 'arc' } | { ok: false; reason: string };

/**
 * The receiver's own results, as one header value with the authserv-id first, or null when AUTHSERV_ID / AUTHSERV_HEADER
 * are not configured or no header of the configured kind names AUTHSERV_ID (the rules at the top of this file).
 */
export function trustedResults(headers: AuthHeaders, authservId: string | undefined, only: string | undefined): string | null {
  if (!authservId?.trim()) return null;
  const mode = only?.trim().toLowerCase();
  const want = norm(authservId);
  if (mode === 'ar' && headers.ar && norm(headers.ar.split(';')[0]) === want) return headers.ar;
  if (mode === 'arc' && headers.arc) {
    const [hop, id, ...rest] = headers.arc.split(';');
    if (/^\s*i\s*=\s*1\s*$/i.test(hop) && norm(id ?? '') === want) return [id, ...rest].join(';');
  }
  return null;
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
  const body = trusted.slice(trusted.indexOf(';') + 1).replace(/\([^)]*\)/g, '');
  const clause = body.split(';').map(c => c.trim()).find(c => /^spf\s*=/i.test(c));
  if (!clause || !/^spf\s*=\s*pass\b/i.test(clause)) return false;
  const mailfrom = clause.match(/(?:^|\s)smtp\.mailfrom=([^\s;]+)/i)?.[1];
  return !!mailfrom && norm(mailfrom.split('@').pop() ?? '') === norm(envelopeDomain);
}
