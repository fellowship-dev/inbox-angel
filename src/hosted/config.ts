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
  INTAKE_MAX_TOTAL_REPORTS_PER_DAY?: string;
  INTAKE_MAX_TOTAL_BYTES_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY?: string;
  INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT?: string;
  INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY?: string;
  INTAKE_MAX_ADDRESS_RECORDS_PER_DAY?: string;
  INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY?: string;
  INTAKE_MAX_WORKSPACE_RECORDS?: string;
  INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY?: string;
  INTAKE_MAX_INSTANCE_RECORDS?: string;
  INTAKE_MAX_DECOMPRESSED_BYTES?: string;
  INTAKE_MAX_STORAGE_RETRIES_PER_DAY?: string;
  INTAKE_TRUSTED_REPORTER_ADDRESSES?: string;
  REPORT_COUNTING?: string;
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
/** Records in one aggregate report. Measured (docs/hosted.md, "Measured limits"): parse + store of 5,000 records stays well inside the 128 MB isolate. */
export const DEFAULT_MAX_RECORDS_PER_REPORT = 5_000;
export const DEFAULT_MAX_BYTES_PER_DAY = 50 * 1024 * 1024;
export const DEFAULT_MAX_NEW_IPS_PER_REPORT = 50;
/** Self-host (one tenant, a private address, no daily caps): generous but bounded. Records and the decompressed size are limits there too. */
export const SELFHOST_MAX_RECORDS_PER_REPORT = 20_000;
export const SELFHOST_MAX_NEW_IPS_PER_REPORT = 200;
/** Distinct authenticated reporter domains accepted per token per day. */
export const DEFAULT_MAX_REPORTERS_PER_DAY = 100;

/**
 * Organisations that send DMARC aggregate reports in volume. A proven report from one of these is never refused for want of
 * a reporter slot, and does not use one: an attacker with many cheap DKIM-signing domains can fill the slots of unknown
 * reporters, but not take these.
 */
export const WELL_KNOWN_REPORTERS: readonly string[] = [
  'google.com', 'yahoo.com', 'yahoo.co.jp', 'microsoft.com', 'outlook.com', 'hotmail.com', 'live.com', 'apple.com', 'icloud.com',
  'amazon.com', 'amazonses.com', 'aol.com', 'comcast.net', 'verizon.net', 'att.net', 'mail.ru', 'yandex.ru', 'yandex.net',
  'zoho.com', 'fastmail.com', 'gmx.net', 'gmx.de', 'web.de', 'seznam.cz', 'qq.com', '163.com', 'naver.com', 'linkedin.com',
  'proofpoint.com', 'mimecast.com', 'cisco.com', 'barracuda.com', 'protonmail.com', 'proton.me',
];
/** The one shared bucket for messages without an aligned authentication pass; never touches authenticated allowance. */
export const DEFAULT_MAX_UNAUTH_REPORTS_PER_DAY = 10;
export const DEFAULT_MAX_UNAUTH_BYTES_PER_DAY = 25 * 1024 * 1024;
export const DEFAULT_MAX_UNAUTH_SENDERS_PER_DAY = 5;
/** All unproven mail to one address per UTC day, over every claimed sender (a forger can claim any sender domain). */
export const DEFAULT_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY = 25;
/** Records in one report whose sender the receiver did not prove. */
export const DEFAULT_MAX_UNAUTH_RECORDS_PER_REPORT = 1_000;
/** Messages per UTC day to one report address (token), proven or not. */
export const DEFAULT_MAX_ADDRESS_MESSAGES_PER_DAY = 500;
/** Records stored per UTC day for one report address. */
export const DEFAULT_MAX_ADDRESS_RECORDS_PER_DAY = 200_000;
export const DEFAULT_MAX_WORKSPACE_MESSAGES_PER_DAY = 2_000;
/** Report records a workspace may hold at any time (13 months of data). */
export const DEFAULT_MAX_WORKSPACE_RECORDS = 1_000_000;
export const DEFAULT_MAX_INSTANCE_MESSAGES_PER_DAY = 50_000;
/** Report records the whole instance may hold: sized so the tables and their indexes stay far below D1's 10 GB database limit. */
export const DEFAULT_MAX_INSTANCE_RECORDS = 10_000_000;
/** Decompressed report size (the raw message may still be 25 MiB, a gzip of it far smaller). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
/** Storage failures per domain and UTC day after which a failing message is refused for good instead of being retried. */
export const DEFAULT_MAX_STORAGE_RETRIES_PER_DAY = 20;
/** Per token and day, across every proven reporter that is not well known (slots coming and going do not reset it). */
export const DEFAULT_MAX_TOTAL_REPORTS_PER_DAY = 1000;
export const DEFAULT_MAX_TOTAL_BYTES_PER_DAY = 1024 * 1024 * 1024;
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
  totalReportsPerDay: number;
  totalBytesPerDay: number;
  unauthTotalReportsPerDay: number;
  unauthRecordsPerReport: number;
  addressMessagesPerDay: number;
  addressRecordsPerDay: number;
  workspaceMessagesPerDay: number;
  workspaceRecords: number;
  instanceMessagesPerDay: number;
  instanceRecords: number;
  maxDecompressedBytes: number;
  storageRetriesPerDay: number;
}

export function intakeLimits(env: HostedEnv): IntakeLimits {
  const saas = getMode(env) === 'saas';
  return {
    reportsPerDay: positive(env.INTAKE_MAX_REPORTS_PER_DAY, DEFAULT_MAX_REPORTS_PER_DAY),
    recordsPerReport: positive(env.INTAKE_MAX_RECORDS_PER_REPORT, saas ? DEFAULT_MAX_RECORDS_PER_REPORT : SELFHOST_MAX_RECORDS_PER_REPORT),
    bytesPerDay: positive(env.INTAKE_MAX_BYTES_PER_DAY, DEFAULT_MAX_BYTES_PER_DAY),
    newIpsPerReport: positive(env.INTAKE_MAX_NEW_IPS_PER_REPORT, saas ? DEFAULT_MAX_NEW_IPS_PER_REPORT : SELFHOST_MAX_NEW_IPS_PER_REPORT),
    reportersPerDay: positive(env.INTAKE_MAX_REPORTERS_PER_DAY, DEFAULT_MAX_REPORTERS_PER_DAY),
    unauthReportsPerDay: positive(env.INTAKE_MAX_UNAUTH_REPORTS_PER_DAY, DEFAULT_MAX_UNAUTH_REPORTS_PER_DAY),
    unauthBytesPerDay: positive(env.INTAKE_MAX_UNAUTH_BYTES_PER_DAY, DEFAULT_MAX_UNAUTH_BYTES_PER_DAY),
    unauthSendersPerDay: positive(env.INTAKE_MAX_UNAUTH_SENDERS_PER_DAY, DEFAULT_MAX_UNAUTH_SENDERS_PER_DAY),
    totalReportsPerDay: positive(env.INTAKE_MAX_TOTAL_REPORTS_PER_DAY, DEFAULT_MAX_TOTAL_REPORTS_PER_DAY),
    totalBytesPerDay: positive(env.INTAKE_MAX_TOTAL_BYTES_PER_DAY, DEFAULT_MAX_TOTAL_BYTES_PER_DAY),
    unauthTotalReportsPerDay: positive(env.INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY, DEFAULT_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY),
    unauthRecordsPerReport: positive(env.INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT, DEFAULT_MAX_UNAUTH_RECORDS_PER_REPORT),
    addressMessagesPerDay: positive(env.INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY, DEFAULT_MAX_ADDRESS_MESSAGES_PER_DAY),
    addressRecordsPerDay: positive(env.INTAKE_MAX_ADDRESS_RECORDS_PER_DAY, DEFAULT_MAX_ADDRESS_RECORDS_PER_DAY),
    workspaceMessagesPerDay: positive(env.INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY, DEFAULT_MAX_WORKSPACE_MESSAGES_PER_DAY),
    workspaceRecords: positive(env.INTAKE_MAX_WORKSPACE_RECORDS, DEFAULT_MAX_WORKSPACE_RECORDS),
    instanceMessagesPerDay: positive(env.INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY, DEFAULT_MAX_INSTANCE_MESSAGES_PER_DAY),
    instanceRecords: positive(env.INTAKE_MAX_INSTANCE_RECORDS, DEFAULT_MAX_INSTANCE_RECORDS),
    maxDecompressedBytes: Math.min(positive(env.INTAKE_MAX_DECOMPRESSED_BYTES, saas ? DEFAULT_MAX_DECOMPRESSED_BYTES : MAX_REPORT_BYTES), MAX_REPORT_BYTES),
    storageRetriesPerDay: positive(env.INTAKE_MAX_STORAGE_RETRIES_PER_DAY, DEFAULT_MAX_STORAGE_RETRIES_PER_DAY),
  };
}

export const maxHostedDomainsPerWorkspace = (env: HostedEnv): number =>
  positive(env.HOSTED_MAX_DOMAINS_PER_WORKSPACE, DEFAULT_MAX_HOSTED_DOMAINS_PER_WORKSPACE);
