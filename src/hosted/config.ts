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
  INTAKE_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY?: string;
  INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY?: string;
  INTAKE_MAX_UNKNOWN_RECORDS_PER_REPORT?: string;
  INTAKE_MAX_UNKNOWN_NEW_IPS_PER_REPORT?: string;
  INTAKE_MAX_UNAUTH_REPORTS_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_BYTES_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT?: string;
  INTAKE_MAX_NONREGISTRY_DECOMPRESSED_BYTES?: string;
  INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY?: string;
  INTAKE_MAX_ADDRESS_RECORDS_PER_DAY?: string;
  INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY?: string;
  INTAKE_MAX_WORKSPACE_RECORDS?: string;
  INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY?: string;
  INTAKE_MAX_INSTANCE_RECORDS?: string;
  INTAKE_MAX_DECOMPRESSED_BYTES?: string;
  INTAKE_MAX_RAW_BYTES?: string;
  INTAKE_MAX_STORAGE_RETRIES_PER_DAY?: string;
  INTAKE_KNOWN_REPORTERS?: string;
  INTAKE_KNOWN_REPORTERS_DISABLE?: string;
  REPORT_COUNTING?: string;
  AUTHSERV_ID?: string;
  AUTHSERV_HEADER?: string;
  HOSTED_MAX_DOMAINS_PER_WORKSPACE?: string;
}

/** The ceiling for the raw message and the decompressed report (Cloudflare's own inbound limit). The defaults are lower: see below. */
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
/**
 * Records in one aggregate report. Measured under wrangler dev (workerd), docs/hosted.md "Measured limits": the first message through an isolate
 * adds ~44 MB of resident memory at 2,000 records, and the worst combined case (records, decompressed size and raw size all at their caps,
 * incompressible padding) ~77 MB, inside the 128 MB isolate with room for the rest.
 */
export const DEFAULT_MAX_RECORDS_PER_REPORT = 2_000;
export const DEFAULT_MAX_BYTES_PER_DAY = 50 * 1024 * 1024;
export const DEFAULT_MAX_NEW_IPS_PER_REPORT = 50;
/** Self-host (one tenant, a private address, no daily caps): generous but bounded. Records and the decompressed size are limits there too. */
export const SELFHOST_MAX_RECORDS_PER_REPORT = 2_500;
export const SELFHOST_MAX_NEW_IPS_PER_REPORT = 200;

/**
 * Authenticated reporters that are not on the known-reporters list (src/dmarc/known-reporters.ts): their reports are stored but not counted,
 * so they get a small allowance, per reporter domain and in total per report address. A genuine receiver sends one report per domain per day
 * (some send a few), so 5 per reporter leaves room for retries and resends; 20 in total per address bounds what any number of invented
 * reporter domains can store. Records per report are capped much lower than for a known reporter (a stranger's report is never counted).
 */
export const DEFAULT_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY = 5;
export const DEFAULT_MAX_UNKNOWN_REPORTS_PER_DAY = 20;
export const DEFAULT_MAX_UNKNOWN_RECORDS_PER_REPORT = 1_000;
/** IP enrichment (DNS lookups) for a report from an authenticated unknown reporter: a small budget. Unauthenticated reports get none. */
export const DEFAULT_MAX_UNKNOWN_NEW_IPS_PER_REPORT = 10;
/**
 * Mail that could not be authenticated (stored, never counted, kept 30 days, no IP lookups): the tightest allowance. Per claimed sender domain (the
 * SMTP envelope sender: forgeable, it only spreads the allowance), and in total per report address.
 */
export const DEFAULT_MAX_UNAUTH_REPORTS_PER_DAY = 5;
export const DEFAULT_MAX_UNAUTH_BYTES_PER_DAY = 10 * 1024 * 1024;
export const DEFAULT_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY = 10;
export const DEFAULT_MAX_UNAUTH_RECORDS_PER_REPORT = 200;
/** Decompression cap for any sender that is not a registry reporter. */
export const DEFAULT_MAX_NONREGISTRY_DECOMPRESSED_BYTES = 1024 * 1024;
/** Messages per UTC day to one report address (token), whatever the sender. */
export const DEFAULT_MAX_ADDRESS_MESSAGES_PER_DAY = 500;
/** Records stored per UTC day for one report address. */
export const DEFAULT_MAX_ADDRESS_RECORDS_PER_DAY = 200_000;
export const DEFAULT_MAX_WORKSPACE_MESSAGES_PER_DAY = 2_000;
/** Report records a workspace may hold at any time (13 months of data). */
export const DEFAULT_MAX_WORKSPACE_RECORDS = 1_000_000;
export const DEFAULT_MAX_INSTANCE_MESSAGES_PER_DAY = 50_000;
/** Report records the whole instance may hold: sized so the tables and their indexes stay far below D1's 10 GB database limit. */
export const DEFAULT_MAX_INSTANCE_RECORDS = 10_000_000;
/** Decompressed report size (the XML text: parsing holds ~50x of it in memory, measured). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 1024 * 1024;
export const SELFHOST_MAX_DECOMPRESSED_BYTES = 1.25 * 1024 * 1024;
/**
 * The raw message. Cloudflare delivers up to 25 MiB, but reading the attachment holds several copies at once (measured under workerd: ~4x a 10 MiB message), and a
 * report that fits the decompressed cap is a few hundred KB compressed, so the default stops far short of Cloudflare's limit.
 */
export const DEFAULT_MAX_RAW_BYTES = 2 * 1024 * 1024;
export const SELFHOST_MAX_RAW_BYTES = 2 * 1024 * 1024;
/** Storage failures per domain and UTC day after which a failing message is refused for good instead of being retried. */
export const DEFAULT_MAX_STORAGE_RETRIES_PER_DAY = 20;
export const DEFAULT_MAX_HOSTED_DOMAINS_PER_WORKSPACE = 10;

const positive = (v: string | undefined, dflt: number): number => {
  const n = Number(v?.trim());
  return v && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export interface IntakeLimits {
  /** Per known reporter (counted), per address, per UTC day. */
  reportsPerDay: number;
  recordsPerReport: number;
  bytesPerDay: number;
  newIpsPerReport: number;
  unknownReportsPerReporterPerDay: number;
  unknownReportsPerDay: number;
  unknownRecordsPerReport: number;
  unknownNewIpsPerReport: number;
  unauthReportsPerDay: number;
  unauthBytesPerDay: number;
  unauthTotalReportsPerDay: number;
  unauthRecordsPerReport: number;
  /** Decompression cap for senders that are not registry reporters (registry reporters get maxDecompressedBytes). */
  nonRegistryDecompressedBytes: number;
  addressMessagesPerDay: number;
  addressRecordsPerDay: number;
  workspaceMessagesPerDay: number;
  workspaceRecords: number;
  instanceMessagesPerDay: number;
  instanceRecords: number;
  maxDecompressedBytes: number;
  maxRawBytes: number;
  storageRetriesPerDay: number;
}

export function intakeLimits(env: HostedEnv): IntakeLimits {
  const saas = getMode(env) === 'saas';
  return {
    reportsPerDay: positive(env.INTAKE_MAX_REPORTS_PER_DAY, DEFAULT_MAX_REPORTS_PER_DAY),
    recordsPerReport: positive(env.INTAKE_MAX_RECORDS_PER_REPORT, saas ? DEFAULT_MAX_RECORDS_PER_REPORT : SELFHOST_MAX_RECORDS_PER_REPORT),
    bytesPerDay: positive(env.INTAKE_MAX_BYTES_PER_DAY, DEFAULT_MAX_BYTES_PER_DAY),
    newIpsPerReport: positive(env.INTAKE_MAX_NEW_IPS_PER_REPORT, saas ? DEFAULT_MAX_NEW_IPS_PER_REPORT : SELFHOST_MAX_NEW_IPS_PER_REPORT),
    unknownReportsPerReporterPerDay: positive(env.INTAKE_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY, DEFAULT_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY),
    unknownReportsPerDay: positive(env.INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY, DEFAULT_MAX_UNKNOWN_REPORTS_PER_DAY),
    unknownRecordsPerReport: positive(env.INTAKE_MAX_UNKNOWN_RECORDS_PER_REPORT, DEFAULT_MAX_UNKNOWN_RECORDS_PER_REPORT),
    unknownNewIpsPerReport: positive(env.INTAKE_MAX_UNKNOWN_NEW_IPS_PER_REPORT, DEFAULT_MAX_UNKNOWN_NEW_IPS_PER_REPORT),
    unauthReportsPerDay: positive(env.INTAKE_MAX_UNAUTH_REPORTS_PER_DAY, DEFAULT_MAX_UNAUTH_REPORTS_PER_DAY),
    unauthBytesPerDay: positive(env.INTAKE_MAX_UNAUTH_BYTES_PER_DAY, DEFAULT_MAX_UNAUTH_BYTES_PER_DAY),
    unauthTotalReportsPerDay: positive(env.INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY, DEFAULT_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY),
    unauthRecordsPerReport: positive(env.INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT, DEFAULT_MAX_UNAUTH_RECORDS_PER_REPORT),
    nonRegistryDecompressedBytes: Math.min(positive(env.INTAKE_MAX_NONREGISTRY_DECOMPRESSED_BYTES, DEFAULT_MAX_NONREGISTRY_DECOMPRESSED_BYTES), MAX_REPORT_BYTES),
    addressMessagesPerDay: positive(env.INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY, DEFAULT_MAX_ADDRESS_MESSAGES_PER_DAY),
    addressRecordsPerDay: positive(env.INTAKE_MAX_ADDRESS_RECORDS_PER_DAY, DEFAULT_MAX_ADDRESS_RECORDS_PER_DAY),
    workspaceMessagesPerDay: positive(env.INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY, DEFAULT_MAX_WORKSPACE_MESSAGES_PER_DAY),
    workspaceRecords: positive(env.INTAKE_MAX_WORKSPACE_RECORDS, DEFAULT_MAX_WORKSPACE_RECORDS),
    instanceMessagesPerDay: positive(env.INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY, DEFAULT_MAX_INSTANCE_MESSAGES_PER_DAY),
    instanceRecords: positive(env.INTAKE_MAX_INSTANCE_RECORDS, DEFAULT_MAX_INSTANCE_RECORDS),
    maxDecompressedBytes: Math.min(positive(env.INTAKE_MAX_DECOMPRESSED_BYTES, saas ? DEFAULT_MAX_DECOMPRESSED_BYTES : SELFHOST_MAX_DECOMPRESSED_BYTES), MAX_REPORT_BYTES),
    maxRawBytes: Math.min(positive(env.INTAKE_MAX_RAW_BYTES, saas ? DEFAULT_MAX_RAW_BYTES : SELFHOST_MAX_RAW_BYTES), MAX_REPORT_BYTES),
    storageRetriesPerDay: positive(env.INTAKE_MAX_STORAGE_RETRIES_PER_DAY, DEFAULT_MAX_STORAGE_RETRIES_PER_DAY),
  };
}

export const maxHostedDomainsPerWorkspace = (env: HostedEnv): number =>
  positive(env.HOSTED_MAX_DOMAINS_PER_WORKSPACE, DEFAULT_MAX_HOSTED_DOMAINS_PER_WORKSPACE);

/** The free email check works: always on self-host; hosted only with a canary domain to receive the test email. */
export function emailCheckAvailable(env: HostedEnv): boolean {
  if (getMode(env) !== 'saas') return true;
  return hostedEnabled(env) && !!hostedConfig(env).canaryDomain;
}
