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
