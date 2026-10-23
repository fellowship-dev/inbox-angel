// Did the sender of an inbound email really control the domain of its address?
//
// Enrolment in the onboarding sequence is mail to that address, so it needs a proof the sender cannot forge. Two traps:
//   - The message may carry several Authentication-Results headers; the sender can add its own (a header it wrote is
//     below the one the receiving server added). Only the TOPMOST is the receiver's: it is the one prepended last.
//     `Headers.get` joins duplicates, so this reads the raw header block instead.
//   - SPF alone proves little (an attacker using the same shared sending service as the victim passes it), and a DMARC
//     pass for the From header says nothing about the envelope sender. So: DKIM pass aligned with the address's domain,
//     or DMARC pass for that same domain.
// If AUTHSERV_ID is set, the topmost header must also name that authentication server.

import { organizationalDomain } from '@inbox-angel/dns-checks';
import { parseAuthResults } from './parse-headers';

const MAX_HEADER_BYTES = 128 * 1024;

/** Value of the first (topmost) Authentication-Results header in a raw message, unfolded. Null if none or unreadable. */
export async function topAuthResults(raw: ReadableStream<Uint8Array> | null | undefined): Promise<string | null> {
  if (!raw) return null;
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let text = '';
  try {
    while (size < MAX_HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
      text = new TextDecoder('latin1').decode(Uint8Array.from(chunks.flatMap((c) => [...c])));
      if (/\r?\n\r?\n/.test(text)) break;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
  const block = text.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^authentication-results:\s*(.*)$/i);
    if (m) return m[1];
  }
  return null;
}

/** True when `headerValue` (the topmost Authentication-Results) proves control of `addressDomain`. */
export function provesDomain(headerValue: string | null, addressDomain: string, trustedAuthservId?: string): boolean {
  if (!headerValue) return false;
  if (trustedAuthservId && headerValue.split(';')[0].trim().toLowerCase() !== trustedAuthservId.trim().toLowerCase()) return false;
  const auth = parseAuthResults(headerValue);
  const org = (d: string | null | undefined) => (d ? organizationalDomain(d) ?? d.toLowerCase() : null);
  const target = org(addressDomain);
  if (!auth || !target) return false;
  return (auth.dkim?.result === 'pass' && org(auth.dkim.domain) === target) || (auth.dmarc?.result === 'pass' && org(auth.dmarc.domain) === target);
}
