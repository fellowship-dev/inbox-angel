// What a live DNS read says about a domain's SPF and DMARC, in the shape `domains.recordDnsCheck` stores.
//
// A field is `undefined` when DNS could not answer (failure), `null` when DNS answered "no record", and the value
// otherwise. Unknown is never folded into absent.

import { createResolver, isSpfRecord, lookupDmarc, type DmarcLookup, type Resolver, type TxtResult } from '@ready-set-mail/dns-checks';
import type { DmarcFacts } from '@ready-set-mail/db';
import { RECORDS_SEPARATOR, lookupSpf } from './dns-check';

/** SPF from the TXT answer at the domain (several v=spf1 records are joined, like lookupSpf does). */
export function spfFromTxt(records: readonly string[]): string | null {
  const spf = records.filter(isSpfRecord).map(r => r.trim());
  return spf.length ? spf.join(RECORDS_SEPARATOR) : null;
}

/**
 * The DMARC policy that applies to the domain, from the package's RFC 7489 discovery (`lookupDmarc`: the domain's own
 * record, else its organizational domain's). The policy is the EFFECTIVE one: an own record's `p=`; an inherited
 * record's `sp=` when it has one, else its `p=`. `undefined`: DNS could not answer, so nothing is known.
 * `null` policy with an `issue`: a record exists but receivers get no policy from it (several records, or no valid `p=`).
 */
export function dmarcFactsFromLookup(l: DmarcLookup): DmarcFacts | undefined {
  if (l.status === 'error') return undefined;
  const inherited_from = l.inherited ? l.organizationalDomain : null;
  if (l.status === 'none') return { policy: null, issue: null, inherited_from: null };
  if (l.status === 'multiple') return { policy: null, issue: 'multiple', inherited_from };
  if (!l.record?.valid) return { policy: null, issue: 'invalid', inherited_from };
  return { policy: l.inherited ? l.record.subdomainPolicy : l.record.policy, issue: null, inherited_from };
}

/**
 * A resolver that answers the names in `known` from what the caller already fetched (no second subrequest), passes
 * everything else through, and notes whether `domain` itself came back NXDOMAIN.
 */
export function observingResolver(base: Resolver, domain: string, known: Record<string, TxtResult> = {}): Resolver & { apexNxdomain(): boolean } {
  let nx = false;
  const apex = domain.toLowerCase();
  return {
    ...base,
    resolve: base.resolve,
    async txt(name) {
      const key = name.toLowerCase();
      const r = known[key] ?? (await base.txt(name));
      if (key === apex && r.status === 'nxdomain') nx = true;
      return r;
    },
    apexNxdomain: () => nx,
  };
}

/** DMARC facts for a domain whose own `_dmarc.<domain>` answer was already fetched; the parent is looked up only when needed. */
export function dmarcFactsFor(resolver: Resolver, domain: string, own: TxtResult): Promise<DmarcFacts | undefined> {
  return dmarcLookupFor(resolver, domain, own).then(dmarcFactsFromLookup);
}

/** The full RFC 7489 lookup behind `dmarcFactsFor` (the record itself included), for callers that also show it. */
export function dmarcLookupFor(resolver: Resolver, domain: string, own: TxtResult): Promise<DmarcLookup> {
  const seeded = observingResolver(resolver, domain, { [`_dmarc.${domain.toLowerCase()}`]: own });
  return lookupDmarc(seeded, domain);
}

export interface DnsSnapshot {
  spf_record?: string | null;
  spf_lookup_count?: number;
  dmarc?: DmarcFacts;
  /** DNS says the domain itself does not exist (RCODE 3 for its TXT), as opposed to existing with no record. */
  nxdomain: boolean;
}

/**
 * Read a domain's SPF (with its lookup count) and effective DMARC from DNS, for the daily refresh. A lookup that
 * could not be answered leaves its field out. Subrequests: the SPF walk, 1 for `_dmarc.<domain>`, and 1 more for the
 * organizational domain when the domain has no DMARC record of its own.
 */
export async function snapshotDns(domain: string, base: Resolver = createResolver()): Promise<DnsSnapshot> {
  const resolver = observingResolver(base, domain);
  const out: DnsSnapshot = { nxdomain: false };
  try {
    const spf = await lookupSpf(domain, resolver); // throws on a DNS failure; null is an authoritative "no SPF"
    out.spf_record = spf?.raw ?? null;
    if (spf?.lookup_count !== undefined) out.spf_lookup_count = spf.lookup_count;
  } catch (e) {
    console.warn(`[monitor] SPF lookup refresh failed for ${domain}:`, e);
  }
  try {
    out.dmarc = dmarcFactsFromLookup(await lookupDmarc(resolver, domain));
    if (!out.dmarc) console.warn(`[monitor] DMARC lookup refresh failed for ${domain}`);
  } catch (e) {
    console.warn(`[monitor] DMARC lookup refresh failed for ${domain}:`, e);
  }
  out.nxdomain = resolver.apexNxdomain();
  return out;
}
