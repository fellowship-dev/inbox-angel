// Hosted (SaaS) configuration, all from the environment. Nothing here applies to self-host:
// `hostedEnabled` is false unless MODE=saas and SAAS_ENABLED=1.

import { getMode } from '../tenancy/mode';

export interface HostedEnv {
  MODE?: string;
  SAAS_ENABLED?: string;
  INTAKE_DOMAIN?: string;
  CANARY_DOMAIN?: string;
  HOSTED_RECORDS_ZONE?: string;
  HOSTED_RECORDS_LABEL?: string;
  HOSTED_RECORDS_TOKEN?: string;
  INTAKE_MAX_REPORTS_PER_DAY?: string;
  INTAKE_MAX_RECORDS_PER_REPORT?: string;
  INTAKE_MAX_BYTES_PER_DAY?: string;
  INTAKE_MAX_NEW_IPS_PER_REPORT?: string;
  INTAKE_MAX_REPORTERS_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_REPORTS_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_BYTES_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_SENDERS_PER_DAY?: string;
  AUTHSERV_ID?: string;
  AUTHSERV_HEADER?: string;
  HOSTED_MAX_DOMAINS_PER_WORKSPACE?: string;
}

/** Largest report (raw message, and decompressed attachment) accepted by the central intake. */
export const MAX_REPORT_BYTES = 25 * 1024 * 1024;

export function hostedEnabled(env: Pick<HostedEnv, 'MODE' | 'SAAS_ENABLED'>): boolean {
  return getMode(env) === 'saas' && env.SAAS_ENABLED === '1';
}

const clean = (v: string | undefined): string | undefined => v?.trim().toLowerCase().replace(/^\.+|\.+$/g, '') || undefined;

export interface HostedConfig {
  /** Domain of the central report address, e.g. rua.inboxangel.io. */
  intakeDomain?: string;
  /** Domain of the anonymous free-check address, e.g. canary.inboxangel.io. */
  canaryDomain?: string;
  /** Zone that holds the hosted records, e.g. inboxangel.io. */
  recordsZone?: string;
  /** The single label under the zone that every hosted record lives below, e.g. h. */
  recordsLabel: string;
}

export function hostedConfig(env: HostedEnv): HostedConfig {
  return {
    intakeDomain: clean(env.INTAKE_DOMAIN),
    canaryDomain: clean(env.CANARY_DOMAIN),
    recordsZone: clean(env.HOSTED_RECORDS_ZONE),
    recordsLabel: clean(env.HOSTED_RECORDS_LABEL) ?? 'h',
  };
}

/** Apex of everything the hosted-records writer may touch: `h.inboxangel.io`. */
export function hostedApex(cfg: HostedConfig): string | undefined {
  return cfg.recordsZone ? `${cfg.recordsLabel}.${cfg.recordsZone}` : undefined;
}

/** Defaults for the per-token intake caps and the per-workspace hosted-domain cap (each overridable by env). */
/** Per authenticated reporter domain, per intake token, per UTC day. */
export const DEFAULT_MAX_REPORTS_PER_DAY = 50;
export const DEFAULT_MAX_RECORDS_PER_REPORT = 20_000;
export const DEFAULT_MAX_BYTES_PER_DAY = 50 * 1024 * 1024;
export const DEFAULT_MAX_NEW_IPS_PER_REPORT = 50;
/** Distinct authenticated reporter domains accepted per token per day. */
export const DEFAULT_MAX_REPORTERS_PER_DAY = 20;
/** The one shared bucket for messages without an aligned authentication pass; never touches authenticated allowance. */
export const DEFAULT_MAX_UNAUTH_REPORTS_PER_DAY = 200;
export const DEFAULT_MAX_UNAUTH_BYTES_PER_DAY = 1024 * 1024 * 1024;
export const DEFAULT_MAX_UNAUTH_SENDERS_PER_DAY = 50;
export const DEFAULT_MAX_HOSTED_DOMAINS_PER_WORKSPACE = 10;

const positive = (v: string | undefined, dflt: number): number => {
  const n = Number(v?.trim());
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export interface IntakeLimits {
  /** Per authenticated reporter domain. */
  reportsPerDay: number;
  recordsPerReport: number;
  bytesPerDay: number;
  newIpsPerReport: number;
  reportersPerDay: number;
  unauthReportsPerDay: number;
  unauthBytesPerDay: number;
  unauthSendersPerDay: number;
}

export function intakeLimits(env: HostedEnv): IntakeLimits {
  return {
    reportsPerDay: positive(env.INTAKE_MAX_REPORTS_PER_DAY, DEFAULT_MAX_REPORTS_PER_DAY),
    recordsPerReport: positive(env.INTAKE_MAX_RECORDS_PER_REPORT, DEFAULT_MAX_RECORDS_PER_REPORT),
    bytesPerDay: positive(env.INTAKE_MAX_BYTES_PER_DAY, DEFAULT_MAX_BYTES_PER_DAY),
    newIpsPerReport: positive(env.INTAKE_MAX_NEW_IPS_PER_REPORT, DEFAULT_MAX_NEW_IPS_PER_REPORT),
    reportersPerDay: positive(env.INTAKE_MAX_REPORTERS_PER_DAY, DEFAULT_MAX_REPORTERS_PER_DAY),
    unauthReportsPerDay: positive(env.INTAKE_MAX_UNAUTH_REPORTS_PER_DAY, DEFAULT_MAX_UNAUTH_REPORTS_PER_DAY),
    unauthBytesPerDay: positive(env.INTAKE_MAX_UNAUTH_BYTES_PER_DAY, DEFAULT_MAX_UNAUTH_BYTES_PER_DAY),
    unauthSendersPerDay: positive(env.INTAKE_MAX_UNAUTH_SENDERS_PER_DAY, DEFAULT_MAX_UNAUTH_SENDERS_PER_DAY),
  };
}

export const maxHostedDomainsPerWorkspace = (env: HostedEnv): number =>
  positive(env.HOSTED_MAX_DOMAINS_PER_WORKSPACE, DEFAULT_MAX_HOSTED_DOMAINS_PER_WORKSPACE);
