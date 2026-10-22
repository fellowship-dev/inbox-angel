// Quota of the hosted-records zone(s), and the seam for adding more.
//
// A Cloudflare Pro zone holds at most 3,500 DNS records. Every hosted domain costs 3 to 5 of them,
// and the limit counts everything in the zone, ours or not. We track the count per zone, warn at
// 3,200 and refuse to write past the limit.
//
// Sharding: `configuredZones()` is the only place that knows which zones exist, and every hosted
// domain stores the `zone_key` it lives in. Today there is one zone (HOSTED_RECORDS_ZONE); a second
// zone means returning a second entry here (and a second `<id>.h.<zone2>` target in the pointer
// instructions), without touching the writer, the quota logic or existing domains.

import type { BoundEnv } from '../index';
import { globalQueries } from '@inbox-angel/db';
import { hostedConfig } from './config';

export const PRO_RECORD_LIMIT = 3500;
export const QUOTA_WARN_AT = 3200;
/** Most records one hosted domain needs: DMARC, SPF, TLS-RPT, MTA-STS TXT and the MTA-STS policy host. */
export const MAX_RECORDS_PER_DOMAIN = 5;

export type QuotaLevel = 'ok' | 'warn' | 'full';

export interface ZoneQuota { count: number; limit: number; level: QuotaLevel }

/** `ok` below the warning threshold, `warn` from 3,200, `full` once `adding` more records would pass the limit. */
export function assessQuota(count: number, adding = 0, limit = PRO_RECORD_LIMIT, warnAt = QUOTA_WARN_AT): ZoneQuota {
  const level: QuotaLevel = count + adding > limit ? 'full' : count >= warnAt ? 'warn' : 'ok';
  return { count, limit, level };
}

export interface ZoneSlot {
  /** Stable id stored on each hosted domain. */
  key: string;
  /** Zone name, e.g. inboxangel.io. */
  name: string;
}

/** The hosted zones, in the order they fill up. THE shard seam. */
export function configuredZones(env: BoundEnv): ZoneSlot[] {
  const { recordsZone } = hostedConfig(env);
  return recordsZone ? [{ key: 'z1', name: recordsZone }] : [];
}

export function zoneSlot(env: BoundEnv, key: string): ZoneSlot | null {
  return configuredZones(env).find(z => z.key === key) ?? null;
}

export class HostedQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedQuotaError';
  }
}

/** The first zone with room for `needed` more records. Throws HostedQuotaError when every zone is full. */
export async function chooseZone(env: BoundEnv, needed: number): Promise<{ slot: ZoneSlot; quota: ZoneQuota }> {
  const zones = configuredZones(env);
  if (zones.length === 0) throw new HostedQuotaError('No hosted-records zone is configured (HOSTED_RECORDS_ZONE)');
  const db = globalQueries(env.DB);
  for (const slot of zones) {
    const count = (await db.hostedZones.get(slot.key))?.record_count ?? 0;
    const quota = assessQuota(count, needed);
    if (quota.level !== 'full') {
      if (quota.level === 'warn') console.warn(`[hosted] zone ${slot.name} is at ${count}/${quota.limit} records (warning from ${QUOTA_WARN_AT})`);
      return { slot, quota };
    }
  }
  throw new HostedQuotaError('Every hosted-records zone is full; add a zone before enabling more domains');
}
