// Adding a report address to a domain's live DMARC record (RFC 7489 §6.2, §6.3): what to publish, and where.
//
// Built on the one tag parser (dmarc-tags.ts). The record that comes out keeps the policy and every other tag exactly as
// published; only the rua= list changes. Receivers need only honour two rua= addresses (§6.2: "MUST support … at least
// two"), so a record that already lists two never gets a third, or loses one, without the person choosing.

import { parseDmarcTags, readDmarcTag } from './dmarc-tags';
/**
 * The parts of a `lookupDmarc` result (./dmarc) this module reads. Declared here, not imported, so the dashboard can
 * import this file alone (like dmarc-tags.ts) without compiling the resolver.
 */
export interface DmarcLookupLike {
  status: 'found' | 'none' | 'multiple' | 'error';
  domain: string;
  record: { raw: string; valid: boolean; issues: string[]; subdomainPolicy: string } | null;
  foundAt: string | null;
  inherited: boolean;
  organizationalDomain: string | null;
  rawRecords?: string[];
  error?: string;
}

/** The address part of one rua= entry: no `mailto:`, no `!size` limit, lower-cased (compared case-insensitively). */
export function ruaEntryAddress(entry: string): string {
  return entry.trim().replace(/^mailto:/i, '').replace(/![^,]*$/, '').trim().toLowerCase();
}

/** The rua= entries of a record, as published (trimmed, empty ones dropped). */
export function ruaEntries(record: string): string[] {
  for (const part of record.split(';')) {
    const tag = readDmarcTag(part);
    if (tag?.key === 'rua') return tag.value.split(',').map((e) => e.trim()).filter(Boolean);
  }
  return [];
}

/** True when the record's rua= list names `address` (any letter case, with or without mailto: or a size limit). */
export function recordHasAddress(record: string, address: string): boolean {
  const ours = ruaEntryAddress(address);
  return ruaEntries(record).some((e) => ruaEntryAddress(e) === ours);
}

const strip = (record: string) => record.trim().replace(/[;\s]+$/, '');

/**
 * The record with `address` in its rua= list, every other tag unchanged and in place. `replace` names one existing entry
 * (as published) to swap for ours; without it ours is appended. A record without rua= gets one at the end.
 */
export function withReportAddress(record: string, address: string, replace?: string): string {
  const ours = `mailto:${address.trim()}`;
  const parts = strip(record).split(';');
  const i = parts.findIndex((p) => readDmarcTag(p)?.key === 'rua');
  if (i < 0) return `${parts.join(';')}; rua=${ours}`;
  const part = parts[i] ?? '';
  const entries = ruaEntries(record);
  // Replace only an entry that is really there; anything else appends, so ours is never left out.
  const next = replace !== undefined && entries.includes(replace) ? entries.map((e) => (e === replace ? ours : e)) : [...entries, ours];
  parts[i] = `${/^\s*/.exec(part)?.[0] ?? ''}rua=${next.join(',')}`;
  return parts.join(';');
}

/**
 * A record for a subdomain that today follows its organizational domain's record, carrying exactly the enforcement in
 * force, never weaker or stricter: `p=` the policy the subdomain gets now (the parent's `sp=`, else its `p=`), the
 * parent's `pct=` when that policy enforces and covers less than 100%, and the parent's `adkim=`/`aspf=` when it sets
 * them. The same shape as the dashboard's `offerEnforcement` + `recordFor` (web/src/lib/dmarc-coverage.ts), checked by
 * a parity test there. Reports for the subdomain then go to `address` only.
 */
export function ownRecordFromInherited(parentRecord: string, effectivePolicy: string, address?: string): string {
  const tags = parseDmarcTags(parentRecord);
  const out = ['v=DMARC1', `p=${effectivePolicy}`];
  const pct = /^\d+$/.test(tags['pct'] ?? '') ? parseInt(tags['pct']!, 10) : 100;
  if ((effectivePolicy === 'quarantine' || effectivePolicy === 'reject') && pct < 100) out.push(`pct=${pct}`);
  for (const key of ['adkim', 'aspf'] as const) {
    const v = tags[key]?.toLowerCase();
    if (v === 'r' || v === 's') out.push(`${key}=${v}`);
  }
  if (address) out.push(`rua=mailto:${address.trim()}`);
  return out.join('; ');
}

/** One record to publish at `name`. */
export interface RecordOption {
  /** The existing rua= entry this option replaces, as published; null when nothing is replaced. */
  replaces: string | null;
  record: string;
}

export type ReportAddressPlan =
  /** The record that applies already lists the address. */
  | { kind: 'published'; name: string; record: string }
  /** Publish `record` at `name` (TXT). `current` is what is there now (null: no DMARC record). */
  | { kind: 'add'; name: string; current: string | null; record: string; created: boolean }
  /** The record already lists two or more addresses: the person chooses what to replace (or to add a third anyway). */
  | { kind: 'choose'; name: string; current: string | null; existing: string[]; options: RecordOption[]; created: boolean }
  /** Several DMARC records at one name: receivers ignore them all (§6.6.3), so nothing can be added until one remains. */
  | { kind: 'multiple'; name: string; records: string[] }
  /** The record that applies has no valid p= (missing or not none/quarantine/reject): it must be fixed before anything is added. */
  | { kind: 'invalid'; name: string; record: string; issues: string[] };

export interface InheritedPlan {
  kind: 'inherited';
  /** The organizational domain whose record applies today. */
  from: string;
  /** Its record, as published. */
  parent_record: string;
  /** The policy this subdomain gets from it today, and the tag it comes from (sp= when the parent sets a valid one, else p=). */
  policy: string;
  policy_tag: 'sp' | 'p';
  /** True when the parent's record already lists this address (reports for the parent are then refused: see the copy). */
  parent_has_address: boolean;
  /** A record of the subdomain's own that keeps that policy and adds the address. */
  own: OwnPlan;
}

export type OwnPlan = Extract<ReportAddressPlan, { kind: 'published' | 'add' | 'choose' }>;

/** Ours added to `current` (or a fresh record), keeping the two-address rule: two or more entries mean a choice. */
function addTo(name: string, current: string, address: string, created: boolean): OwnPlan {
  if (recordHasAddress(current, address)) return created ? { kind: 'add', name, current: null, record: current, created } : { kind: 'published', name, record: current };
  const existing = ruaEntries(current);
  const shownCurrent = created ? null : current;
  if (existing.length < 2) return { kind: 'add', name, current: shownCurrent, record: withReportAddress(current, address), created };
  const options: RecordOption[] = existing.map((e) => ({ replaces: e, record: withReportAddress(current, address, e) }));
  options.push({ replaces: null, record: withReportAddress(current, address) });
  return { kind: 'choose', name, current: shownCurrent, existing, options, created };
}

/**
 * What to publish so reports for `domain` reach `address`, from a live DMARC lookup (lookupDmarc). Null when the lookup
 * failed: unknown is never "no record".
 */
export function planReportAddress(lookup: DmarcLookupLike, address: string): ReportAddressPlan | InheritedPlan | null {
  if (lookup.status === 'error') return null;
  const own = `_dmarc.${lookup.domain}`;
  if (lookup.status === 'multiple') return { kind: 'multiple', name: lookup.foundAt ?? own, records: lookup.rawRecords ?? [] };
  if (lookup.status === 'none' || !lookup.record) {
    return { kind: 'add', name: own, current: null, record: `v=DMARC1; p=none; rua=mailto:${address.trim()}`, created: true };
  }
  const record = lookup.record.raw;
  // A record without a valid p= is not one to build on: say so, propose nothing.
  if (!lookup.record.valid) return { kind: 'invalid', name: lookup.foundAt ?? own, record, issues: lookup.record.issues };
  if (!lookup.inherited) return addTo(own, record, address, false);
  const policy = lookup.record.subdomainPolicy;
  const sp = parseDmarcTags(record)['sp']?.toLowerCase();
  const policy_tag = sp === 'none' || sp === 'quarantine' || sp === 'reject' ? 'sp' as const : 'p' as const;
  // The subdomain's own record: the enforcement in force today, reports to our address.
  return {
    kind: 'inherited',
    from: lookup.organizationalDomain ?? lookup.domain,
    parent_record: record,
    policy,
    policy_tag,
    parent_has_address: recordHasAddress(record, address),
    own: { kind: 'add', name: own, current: null, record: ownRecordFromInherited(record, policy, address), created: true },
  };
}
