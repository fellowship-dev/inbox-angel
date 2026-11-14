// The fixed hosted report address: `rua@<INTAKE_DOMAIN>`, the same for every customer.
//
// It carries no token, so the report itself says which domain it is about. Anyone can mail this address, so before any
// allowance, full parse, enrichment or storage the intake reads only `feedback/policy_published/domain`:
//   - from at most the first PEEK_BYTES of the decompressed report (inflation stops there; a bomb costs no more),
//   - with a single linear scan (every character is visited a bounded number of times; no regex backtracking),
//   - skipping comments, CDATA and processing instructions the way an XML parser does, and refusing a DOCTYPE.
// The full parse later must find the same domain (src/email/dmarc-report.ts `expectedDomain`), or nothing is stored.

import { Gunzip, Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';
import { normalizeDomain, organizationalDomain } from '@inbox-angel/dns-checks';
import type { BoundEnv } from '../index';
import { forWorkspace } from '@inbox-angel/db';
import { extractAttachmentBytes } from '../email/mime-extract';

export const fixedReportAddress = (intakeDomain: string): string => `rua@${intakeDomain}`;

/** True when `address` is the fixed hosted address of this deployment (any letter case, surrounding space ignored). */
export const isFixedReportAddress = (address: string | null | undefined, intakeDomain: string): boolean =>
  (address ?? '').trim().toLowerCase() === fixedReportAddress(intakeDomain);

/** The most decompressed bytes the peek reads. policy_published comes right after report_metadata, well inside this. */
export const PEEK_BYTES = 64 * 1024;
/** Compressed bytes fed per step: deflate expands at most ~1032:1, so one step yields at most ~66 KB. */
const PEEK_SLICE = 64;
const MAX_ZIP_ENTRIES = 2;

class Enough extends Error {}

/** Up to `limit` bytes of the stream an inflater produces from `bytes`; stops feeding as soon as it has them. */
function inflatePrefix(bytes: Uint8Array, limit: number, make: (ondata: (chunk: Uint8Array) => void) => { push(c: Uint8Array, final?: boolean): void }): Uint8Array {
  const out = new Uint8Array(limit);
  let at = 0;
  const inflater = make((chunk) => {
    const take = Math.min(chunk.length, limit - at);
    out.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= limit) throw new Enough();
  });
  try {
    for (let i = 0; i < bytes.length && at < limit; i += PEEK_SLICE) inflater.push(bytes.subarray(i, i + PEEK_SLICE), i + PEEK_SLICE >= bytes.length);
  } catch (e) {
    if (!(e instanceof Enough)) throw e;
  }
  return out.subarray(0, at);
}

/** The first PEEK_BYTES of the report inside an attachment (gzip, zip with at most two entries, or plain XML). */
export function reportPrefix(bytes: Uint8Array, limit = PEEK_BYTES): Uint8Array {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return inflatePrefix(bytes, limit, (ondata) => new Gunzip(ondata));
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const names: string[] = [];
    unzipSync(bytes, { filter: (f) => { names.push(f.name); return false; } }); // reads the directory only
    if (names.length === 0 || names.length > MAX_ZIP_ENTRIES) throw new Error('Unusable zip archive');
    const pick = names.find((n) => /\.xml$/i.test(n));
    if (!pick) throw new Error('Zip archive holds no .xml report');
    return inflatePrefix(bytes, limit, (ondata) => {
      const unzip = new Unzip((file) => {
        if (file.name !== pick) return;
        file.ondata = (err, chunk) => { if (err) throw err; ondata(chunk); };
        file.start();
      });
      unzip.register(UnzipInflate);
      unzip.register(UnzipPassThrough);
      return unzip;
    });
  }
  return bytes.subarray(0, limit);
}

/**
 * `feedback/policy_published/domain` from the start of a report, or null when it is not there, the XML is not what a
 * report looks like (a DOCTYPE, an unclosed construct, nesting deeper than a report has), or the value is not a plain name.
 * Linear: each step jumps to the next `<` with indexOf and every slice is consumed once.
 */
export function scanPolicyDomain(xml: string): string | null {
  const stack: string[] = [];
  let text: string | null = null; // collecting the domain's text
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) return null;
    if (text !== null) text += xml.slice(i, lt);
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) return null;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) return null;
      if (text !== null) text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) return null; // DOCTYPE and the like: reports have none, and entities could change the name
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return null;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    const closing = tag.startsWith('/');
    const selfClosing = !closing && tag.endsWith('/');
    const raw = (closing ? tag.slice(1) : tag).trim().split(/[\s/]/, 1)[0] ?? '';
    const name = raw.slice(raw.indexOf(':') + 1).toLowerCase();
    if (closing) {
      if (text !== null) {
        if (name !== 'domain') return null;
        const value = text.trim();
        return /^[a-z0-9._-]+$/i.test(value) ? normalizeDomain(value) : null;
      }
      if (stack.pop() !== name) return null;
      if (stack.length === 0) return null; // the root closed without the field
      continue;
    }
    if (text !== null) return null; // markup inside the domain value
    if (selfClosing) continue;
    stack.push(name);
    if (stack.length > 16) return null;
    if (stack.length === 3 && stack[0] === 'feedback' && stack[1] === 'policy_published' && stack[2] === 'domain') text = '';
  }
  return null;
}

/** The report's policy domain from the raw message: attachment → first PEEK_BYTES → linear scan. Throws when unreadable. */
export async function peekPolicyDomain(raw: ReadableStream<Uint8Array>): Promise<string | null> {
  const prefix = reportPrefix(await extractAttachmentBytes(raw));
  return scanPolicyDomain(new TextDecoder('utf-8', { fatal: false }).decode(prefix));
}

/**
 * The names that may own a report about `domain`: the domain itself, then each parent up to and including its
 * organizational domain, longest first. Never a public suffix, never above the organizational domain.
 */
export function reportDomainCandidates(domain: string): string[] {
  const d = normalizeDomain(domain);
  const org = organizationalDomain(d);
  if (!org || !(d === org || d.endsWith(`.${org}`))) return [];
  const out: string[] = [];
  let name = d;
  for (;;) {
    out.push(name);
    if (name === org) return out;
    name = name.slice(name.indexOf('.') + 1);
  }
}

// ── Who may connect reports ─────────────────────────────────

export type ConnectReportsMode = 'owner' | 'all';

/**
 * HOSTED_CONNECT_REPORTS: `owner` (the default, and the answer for any unknown value) lets only workspaces owned by the
 * instance owner (OWNER_EMAIL) connect reports; `all` lets every verified workspace. Until the hardening work for large
 * reports, forged-report weighting and storage caps has landed, keep it at `owner`.
 */
export function connectReportsSetting(env: Pick<BoundEnv, 'HOSTED_CONNECT_REPORTS'>): { mode: ConnectReportsMode; valid: boolean } {
  const v = env.HOSTED_CONNECT_REPORTS?.trim().toLowerCase();
  if (!v) return { mode: 'owner', valid: true };
  if (v === 'all' || v === 'owner') return { mode: v, valid: true };
  return { mode: 'owner', valid: false };
}

/** May this workspace connect (and receive) reports under HOSTED_CONNECT_REPORTS? */
export async function workspaceMayConnectReports(env: Pick<BoundEnv, 'HOSTED_CONNECT_REPORTS' | 'OWNER_EMAIL' | 'DB'>, workspaceId: string): Promise<boolean> {
  if (connectReportsSetting(env).mode === 'all') return true;
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!owner) return false;
  const team = await forWorkspace(env.DB, workspaceId).team.list();
  return team.some((m) => m.role === 'owner' && m.email.toLowerCase() === owner);
}
