// What a live DNS read says about a domain's SPF and DMARC, in the shape `domains.recordDnsCheck` stores.
//
// A field is `undefined` when DNS could not answer (failure, or a record that has no single usable answer),
// `null` when DNS answered "no record", and the value otherwise. Unknown is never folded into absent.

import { isDmarcRecord, isSpfRecord } from '@inbox-angel/dns-checks';
import { parseDmarcTags } from '../dmarc/rollout';
import { RECORDS_SEPARATOR } from './dns-check';

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];

/** SPF from the TXT answer at the domain (several v=spf1 records are joined, like lookupSpf does). */
export function spfFromTxt(records: readonly string[]): string | null {
  const spf = records.filter(isSpfRecord).map(r => r.trim());
  return spf.length ? spf.join(RECORDS_SEPARATOR) : null;
}

/**
 * The published `p=` from the TXT answer at `_dmarc.<domain>`. `null`: no DMARC record. `undefined`: there is one,
 * but receivers get no single policy from it (more than one DMARC record, or no valid `p=`), so nothing is stored.
 * Tags are split on `;`, so `sp=` and `t=` are never read as `p=`.
 */
export function dmarcPolicyFromTxt(records: readonly string[]): string | null | undefined {
  const dmarc = records.filter(isDmarcRecord);
  if (dmarc.length === 0) return null;
  if (dmarc.length > 1) return undefined;
  const p = parseDmarcTags(dmarc[0]).get('p')?.toLowerCase();
  return p && POLICIES.includes(p) ? p : undefined;
}
