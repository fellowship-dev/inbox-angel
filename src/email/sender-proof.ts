// Did the sender of an inbound email really control the domain of its address?
//
// Enrolment in the onboarding sequence is mail to that address, so it needs a proof the sender cannot forge. It fails closed:
//   - AUTHSERV_ID (the authserv-id of the receiving server's own results) must be configured, or nobody is enrolled. Nothing
//     guarantees that the receiver prepends a plain Authentication-Results header; it may add only ARC-Authentication-Results.
//     Until an operator has looked at one routed message and set AUTHSERV_ID (docs/email-funnel.md), the report is still
//     sent but the sender is not enrolled.
//   - Only the TOPMOST header of the kind is read (a header the sender adds sits below the receiver's), from the raw
//     message: `Headers.get` joins duplicates. Its authserv-id must equal AUTHSERV_ID.
//   - The plain header is used if it is ours; otherwise the topmost ARC-Authentication-Results with i=1 and our authserv-id.
//     AUTHSERV_HEADER (`ar` | `arc`) restricts it to one of them: if the receiver adds only one kind, the other can be
//     forged by the sender, so set it once you know which.
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

/** Decide whether the sender proved `addressDomain`. Fails closed, with the reason (for the log; it never names the sender). */
export function proveSender(headers: AuthHeaders, addressDomain: string, authservId: string | undefined, only?: string): SenderProof {
  if (!authservId?.trim()) return { ok: false, reason: 'AUTHSERV_ID is not set' };
  const want = norm(authservId);
  const mode = only?.trim().toLowerCase();

  if (mode !== 'arc' && headers.ar && norm(headers.ar.split(';')[0]) === want) {
    return provesDomain(headers.ar, addressDomain) ? { ok: true, via: 'ar' } : { ok: false, reason: 'the receiver\'s results do not show an aligned DKIM pass or a DMARC pass' };
  }
  if (mode !== 'ar' && headers.arc) {
    const [hop, id, ...rest] = headers.arc.split(';');
    if (/^\s*i\s*=\s*1\s*$/i.test(hop) && norm(id ?? '') === want) {
      return provesDomain([id, ...rest].join(';'), addressDomain) ? { ok: true, via: 'arc' } : { ok: false, reason: 'the receiver\'s ARC results do not show an aligned DKIM pass or a DMARC pass' };
    }
  }
  return { ok: false, reason: headers.ar || headers.arc ? 'no Authentication-Results (or ARC i=1) header names the configured AUTHSERV_ID' : 'the message has no Authentication-Results header' };
}
