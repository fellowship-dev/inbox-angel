// Retention windows. Defaults are the published policy (docs/data-retention.md); each can be changed
// per deployment with an environment variable, in whole days.

import { getMode } from '../tenancy/mode';

export interface RetentionEnv {
  MODE?: string;
  /** Aggregate (rua) report rows and their records. */
  RETENTION_REPORTS_DAYS?: string;
  RETENTION_TLS_DAYS?: string;
  /** Raw report XML / TLS-RPT JSON. 0: never store. Default 30 (self-host), 0 (hosted). */
  RAW_XML_RETENTION_DAYS?: string;
  RETENTION_IP_INFO_DAYS?: string;
  RETENTION_CHECK_RESULTS_DAYS?: string;
  RETENTION_INVITES_DAYS?: string;
  RETENTION_AUDIT_DAYS?: string;
  RETENTION_EVICTED_DAYS?: string;
}

export interface RetentionPolicy {
  reportsDays: number;
  tlsDays: number;
  rawDays: number;
  ipInfoDays: number;
  checkResultsDays: number;
  invitesDays: number;
  auditDays: number;
  /** How long a domain evicted from its unproven holder keeps its report history (for export). */
  evictedDays: number;
}

/** 13 months, as days (365 + 30). */
export const THIRTEEN_MONTHS_DAYS = 395;

/** A non-negative whole number of days from the environment, else the default. A bad value never disables a window. */
function days(raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** Days raw report XML is kept; 0 means it is not stored at all. Hosted defaults to 0, self-host to 30. */
export function rawXmlRetentionDays(env: Pick<RetentionEnv, 'MODE' | 'RAW_XML_RETENTION_DAYS'>): number {
  return days(env.RAW_XML_RETENTION_DAYS, getMode(env) === 'saas' ? 0 : 30, 0);
}

export function retentionPolicy(env: RetentionEnv): RetentionPolicy {
  return {
    reportsDays: days(env.RETENTION_REPORTS_DAYS, THIRTEEN_MONTHS_DAYS),
    tlsDays: days(env.RETENTION_TLS_DAYS, THIRTEEN_MONTHS_DAYS),
    rawDays: rawXmlRetentionDays(env),
    ipInfoDays: days(env.RETENTION_IP_INFO_DAYS, 30),
    checkResultsDays: days(env.RETENTION_CHECK_RESULTS_DAYS, 30),
    invitesDays: days(env.RETENTION_INVITES_DAYS, 30),
    auditDays: days(env.RETENTION_AUDIT_DAYS, 365),
    evictedDays: days(env.RETENTION_EVICTED_DAYS, 30),
  };
}
