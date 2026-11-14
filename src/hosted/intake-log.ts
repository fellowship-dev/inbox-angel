// Operator visibility for inbound mail (G7): one structured JSON line per message, and a way to learn the right AUTHSERV_ID
// from a real message without storing it.
//
// A line never holds report contents, a recipient token or address, a sender address, or a customer's domain name: only the
// outcome, a reason code (src/hosted/reasons.ts), whether the sender was proven, the REPORTING ORGANISATION's domain (it is not
// personal data and is what an operator needs to see who is reporting), sizes, counts, timing and the internal workspace and
// domain ids. Read it with `wrangler tail --format json`.

import type { AuthHeaders } from '../email/sender-proof';
import type { Outcome, ReasonCode } from './reasons';

export type IntakeKind = 'rua' | 'tls-rpt' | 'canary' | 'other';

export interface IntakeLogLine {
  kind: IntakeKind;
  outcome: Outcome;
  reason: ReasonCode;
  /** counted (authenticated AND a registry reporter), unknown (authenticated, not in the registry), unauthenticated; null: refused before that. */
  tier: 'counted' | 'unknown' | 'unauthenticated' | null;
  /** The reporter identity: the registry id, else the authenticated organisational domain, else '~unauth' (null: not decided). */
  reporter: string | null;
  /** The passing DKIM organisation and the From organisation of the carrier: reporter data, not customer data. */
  dkim_org: string | null;
  from_org: string | null;
  /** Did report_metadata/email match the registry entry (null: no entry matched the carrier). */
  email_matched: boolean | null;
  /** new | duplicate | superseded (a counted report replaced an uncounted one); null: not reached. */
  dedup: 'new' | 'duplicate' | 'superseded' | null;
  /** Raw message size in bytes. */
  size: number;
  /** Records in the report (null: not read). */
  records: number | null;
  /** Milliseconds from the start of the handler. */
  ms: number;
  ws: string | null;
  dom: number | null;
}

/** Longest sender-written text (org_name, report email, From) kept in a log line or in the candidates list. */
export const SENDER_TEXT_MAX = 64;

/**
 * Text a SENDER wrote (the report's org_name and email, the From address), made safe to log and list: control characters (C0, DEL, C1, line and
 * paragraph separators, bidi controls) are dropped, runs of whitespace collapse to one space, and the result is cut at SENDER_TEXT_MAX characters. An
 * attacker can otherwise put escape sequences, newlines or a thousand characters into a line an operator reads or a list the owner opens.
 */
export function senderText(v: string | null | undefined, max = SENDER_TEXT_MAX): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** An authenticated reporter that is not in the registry: logged on every message so the list can grow by hand (never auto-promoted). */
export function logReporterCandidate(c: { dkim_org: string; from: string; org_name: string; report_email: string; reason: string | null }): void {
  console.log(JSON.stringify({ evt: 'intake_reporter_candidate', v: 1, ...c }));
}

/** One line per message. Accepted mail logs at info level; refused and deferred mail at warn level so `tail --status` filters work. */
type LineInput = Pick<IntakeLogLine, 'kind' | 'outcome' | 'reason' | 'size' | 'ms'> & Partial<IntakeLogLine>;

export function logIntake(input: LineInput): void {
  const line: IntakeLogLine = { tier: null, reporter: null, dkim_org: null, from_org: null, email_matched: null, dedup: null, records: null, ws: null, dom: null, ...input };
  const text = JSON.stringify({ evt: 'intake', v: 1, ...line });
  if (line.outcome === 'accepted' || line.outcome === 'duplicate') console.log(text);
  else console.warn(text);
}

// ── authserv discovery ────────────────────────────────────────

/** Longest value logged for an observed authserv-id. A real one is a host name (mx.cloudflare.net is 17 characters). */
export const OBSERVED_MAX = 64;

/**
 * An observed authserv-id, made safe to log: printable ASCII without spaces (a trailing version number or comment is dropped; anything else, an address
 * included, gives null), at most OBSERVED_MAX characters. It is the SENDER'S text when the receiver added no header of its own, so it is
 * only ever logged as an observation, never as an instruction.
 */
export function observed(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.replace(/\([^)]*\)/g, ' ').trim().replace(/\s+\d{1,3}$/, ''); // comments and a trailing authres-version are not part of the id
  if (!/^[\x21-\x7e]+$/.test(t) || t.includes('@')) return null; // not printable ASCII without spaces, or an address: not logged
  return t.slice(0, OBSERVED_MAX);
}

export interface SeenAuthserv {
  /** authserv-id of the topmost Authentication-Results, as observed (null: none). */
  ar: string | null;
  /** The topmost ARC-Authentication-Results: its instance number and authserv-id, as observed. */
  arc: { i: number | null; id: string | null } | null;
}

export function seenAuthserv(h: Pick<AuthHeaders, 'ar' | 'arc'>): SeenAuthserv {
  const ar = h.ar ? observed(h.ar.split(';')[0]) : null;
  let arc: SeenAuthserv['arc'] = null;
  if (h.arc) {
    const [hop, id] = h.arc.split(';');
    const i = /^\s*i\s*=\s*(\d{1,6})\s*$/i.exec(hop ?? '');
    arc = { i: i ? Number(i[1]) : null, id: observed(id) };
  }
  return { ar, arc };
}

const WINDOW_MS = 3_600_000;
const MAX_PER_WINDOW = 5;

/** At most MAX_PER_WINDOW lines per window: a counter in a closure (this is isolate-wide, not tenant state). */
function windowLimiter() {
  let windowStart = 0;
  let logged = 0;
  return {
    allow(now: number): boolean {
      if (now - windowStart > WINDOW_MS) { windowStart = now; logged = 0; }
      return logged++ < MAX_PER_WINDOW;
    },
    reset(): void { windowStart = 0; logged = 0; },
  };
}
const discoveryLimit = windowLimiter();

/** Test hook. */
export function resetAuthservDiscovery(): void { discoveryLimit.reset(); }

/**
 * When AUTHSERV_ID / AUTHSERV_HEADER are not set (or are set and the message's results name another server), log what the topmost Authentication-Results
 * and ARC-Authentication-Results headers of an inbound message said, so the operator can compare it with a message they sent themselves. It is an OBSERVATION:
 * if the receiver added no header of its own, the topmost one is the sender's, so the value must be confirmed against a message the operator sent before
 * AUTHSERV_ID is set from it. At most 5 lines per isolate per hour; nothing is stored; never an address.
 */
export function logAuthservDiscovery(h: Pick<AuthHeaders, 'ar' | 'arc'>, env: { AUTHSERV_ID?: string; AUTHSERV_HEADER?: string }, trusted: boolean, now = Date.now()): void {
  if (trusted || (!h.ar && !h.arc)) return;
  if (!discoveryLimit.allow(now)) return;
  const seen = seenAuthserv(h);
  const configured = !!env.AUTHSERV_ID?.trim() && ['ar', 'arc'].includes(env.AUTHSERV_HEADER?.trim().toLowerCase() ?? '');
  console.log(JSON.stringify({
    evt: 'intake_authserv', v: 2, configured,
    observed_ar: seen.ar, observed_arc: seen.arc?.id ?? null, observed_arc_i: seen.arc?.i ?? null,
    note: 'observed on an inbound message; confirm against a message you sent yourself before setting AUTHSERV_ID',
  }));
}
