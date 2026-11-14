// Can any report be counted right now? A pure decision over what inbound report mail carried (counters, no address), plus the loader.
// Exposed so the setup check (src/setup/preflight.ts) can call `describeAuthStatus` later without reading D1 itself.

import { globalQueries } from '@ready-set-mail/db';
import { reportCounting } from '../dmarc/counting';
import { storageDropText, utcMinute } from './visibility';

export type AuthStatusKind = 'ok' | 'no_traffic' | 'unconfigured' | 'no_results' | 'foreign_authserv' | 'unauthenticated_only';

export interface AuthObservations {
  /** AUTHSERV_ID and AUTHSERV_HEADER are both set. */
  configured: boolean;
  /** Messages in the window by what they carried. */
  ok: number;
  present: number;
  absent: number;
  foreign: number;
}

export interface AuthStatus { kind: AuthStatusKind; text: string | null; observations: AuthObservations }

export const AUTH_TEXT = {
  unconfigured: 'No report can be counted until AUTHSERV_ID and AUTHSERV_HEADER are set.',
  no_results: 'No report can be counted: inbound mail carries no authentication results.',
  foreign_authserv: 'No report can be counted: the authentication results on inbound mail do not name the configured AUTHSERV_ID.',
  unauthenticated_only: 'No report can be counted: no inbound message has authenticated yet.',
} as const;

/** Pure: what the observations mean. `text` is the sentence for the instance owner, or null when all is well (or nothing has arrived yet). */
export function describeAuthStatus(o: AuthObservations): AuthStatus {
  const mk = (kind: AuthStatusKind, text: string | null): AuthStatus => ({ kind, text, observations: o });
  if (!o.configured) return mk('unconfigured', AUTH_TEXT.unconfigured);
  const total = o.ok + o.present + o.absent + o.foreign;
  if (!total) return mk('no_traffic', null);
  if (o.ok > 0) return mk('ok', null);
  if (o.absent > 0 && o.present === 0 && o.foreign === 0) return mk('no_results', AUTH_TEXT.no_results);
  if (o.foreign > 0 && o.present === 0) return mk('foreign_authserv', AUTH_TEXT.foreign_authserv);
  return mk('unauthenticated_only', AUTH_TEXT.unauthenticated_only);
}

/** Load the last 3 days of observations and describe them. */
export async function intakeAuthStatus(env: { DB: D1Database; AUTHSERV_ID?: string; AUTHSERV_HEADER?: string }, nowSeconds = Math.floor(Date.now() / 1000)): Promise<AuthStatus> {
  const since = new Date((nowSeconds - 3 * 86400) * 1000).toISOString().slice(0, 10);
  const rows = await globalQueries(env.DB).authObservations.since(since);
  const n = (k: string) => Number(rows.find((r) => r.scope === 'auth:' + k)?.messages ?? 0);
  const configured = !!env.AUTHSERV_ID?.trim() && ['ar', 'arc'].includes(env.AUTHSERV_HEADER?.trim().toLowerCase() ?? '');
  return describeAuthStatus({ configured, ok: n('ok'), present: n('present'), absent: n('absent'), foreign: n('foreign') });
}

// ── the owner's setup check (src/setup/preflight.ts calls `intakeSetupFindings`) ─────────────────────────────

/** A finding in the shape of `PreflightItem` (src/setup/preflight.ts). Messages name a setting and what it breaks; never a value. */
export interface IntakeSetupFinding { id: 'intake'; severity: 'action' | 'note'; setting: string; message: string }

const CAP_TEXT = {
  cap_instance_day: 'the instance-wide daily message limit (INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY)',
  cap_instance_storage: 'the instance-wide stored-records limit (INTAKE_MAX_INSTANCE_RECORDS)',
  cap_workspace_day: 'a workspace\'s daily message limit (INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY)',
  cap_workspace_storage: 'a workspace\'s stored-records limit (INTAKE_MAX_WORKSPACE_RECORDS)',
  cap_address_day: 'a report address\'s daily message limit (INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY)',
  cap_address_records: 'a report address\'s daily stored-records limit (INTAKE_MAX_ADDRESS_RECORDS_PER_DAY)',
  cap_uncounted_workspace_day: 'a workspace\'s daily limit for uncounted reports (INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY)',
  cap_uncounted_instance_day: 'the instance-wide daily limit for uncounted reports (INTAKE_MAX_UNCOUNTED_INSTANCE_MESSAGES_PER_DAY)',
  cap_uncounted_address_records: 'a report address\'s daily uncounted-records limit (INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY)',
  cap_uncounted_workspace_storage: 'a workspace\'s uncounted-records limit (INTAKE_MAX_UNCOUNTED_WORKSPACE_RECORDS)',
  cap_uncounted_instance_storage: 'the instance-wide uncounted-records limit (INTAKE_MAX_UNCOUNTED_INSTANCE_RECORDS)',
  cap_unattributed_sender_day: 'one sender\'s daily limit for reports about domains nobody connected (INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY)',
  cap_unattributed_total_day: 'the daily limit for reports about domains nobody connected (INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY)',
  fixed_address_busy: 'the shared report address\'s per-minute limit on reports it reads (INTAKE_MAX_FIXED_PEEKS_PER_MINUTE); authenticated senders were deferred, unauthenticated ones refused',
} as const;

/** The setting behind each cap the setup check names. */
const CAP_SETTING = {
  cap_instance_day: 'INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY', cap_instance_storage: 'INTAKE_MAX_INSTANCE_RECORDS', cap_workspace_day: 'INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY',
  cap_workspace_storage: 'INTAKE_MAX_WORKSPACE_RECORDS', cap_address_day: 'INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY', cap_address_records: 'INTAKE_MAX_ADDRESS_RECORDS_PER_DAY',
  cap_uncounted_workspace_day: 'INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY', cap_uncounted_instance_day: 'INTAKE_MAX_UNCOUNTED_INSTANCE_MESSAGES_PER_DAY',
  cap_uncounted_address_records: 'INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY', cap_uncounted_workspace_storage: 'INTAKE_MAX_UNCOUNTED_WORKSPACE_RECORDS',
  cap_uncounted_instance_storage: 'INTAKE_MAX_UNCOUNTED_INSTANCE_RECORDS',
  cap_unattributed_sender_day: 'INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY', cap_unattributed_total_day: 'INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY',
  fixed_address_busy: 'INTAKE_MAX_FIXED_PEEKS_PER_MINUTE',
} as const;

/**
 * What the instance owner should know about report intake, in preflight's finding shape. Silent for a self-hosted server that counts every
 * report (REPORT_COUNTING=all, the self-host default): nothing there depends on authentication. `nowSeconds` is injectable for tests.
 */
export async function intakeSetupFindings(
  env: { DB: D1Database; MODE?: string; REPORT_COUNTING?: string; AUTHSERV_ID?: string; AUTHSERV_HEADER?: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IntakeSetupFinding[]> {
  const out: IntakeSetupFinding[] = [];
  if (reportCounting(env) !== 'all') {
    const status = await intakeAuthStatus(env, nowSeconds);
    if (status.kind === 'unconfigured') {
      out.push({ id: 'intake', severity: 'action', setting: 'AUTHSERV_ID, AUTHSERV_HEADER', message: 'AUTHSERV_ID and AUTHSERV_HEADER are not both set, so no inbound report can be counted: every report is stored but left out of the numbers. Set both after confirming the authserv-id on a message you sent yourself (the Worker logs what it observed, but that is only what an inbound message said).' });
    } else if (status.kind === 'no_results') {
      out.push({ id: 'intake', severity: 'action', setting: 'AUTHSERV_HEADER', message: 'Inbound report mail arrived without any authentication results, so no report can be counted. Check that Email Routing adds Authentication-Results (or ARC-Authentication-Results, then set AUTHSERV_HEADER to arc).' });
    } else if (status.kind === 'foreign_authserv') {
      out.push({ id: 'intake', severity: 'action', setting: 'AUTHSERV_ID', message: 'Inbound report mail carries authentication results, but not from the AUTHSERV_ID you set, so no report can be counted. Set AUTHSERV_ID after confirming the authserv-id on a message you sent yourself (the Worker logs what it observed, but that is only what an inbound message said).' });
    }
  }
  // A COUNTED report that could not be stored because the counted budget is full: loud, per known reporter, from the first drop time.
  const drops = await globalQueries(env.DB).drops.since(nowSeconds - 14 * 86400).catch(() => []);
  for (const d of drops) {
    out.push({ id: 'intake', severity: 'action', setting: 'INTAKE_MAX_WORKSPACE_RECORDS, INTAKE_MAX_INSTANCE_RECORDS, INTAKE_MAX_ADDRESS_RECORDS_PER_DAY', message: `${storageDropText(d.label, utcMinute(d.first_at))}. ${d.domains === 1 ? 'One report address is' : `${d.domains} report addresses are`} affected; raise the storage limit or free room.` });
  }
  const since = new Date((nowSeconds - 3 * 86400) * 1000).toISOString().slice(0, 10);
  const caps = await globalQueries(env.DB).capObservations.since(since).catch(() => []);
  const hit = caps.filter((c) => Number(c.messages) > 0).map((c) => c.scope.slice(4));
  if (hit.length) {
    const names = hit.map((r) => (CAP_TEXT as Record<string, string>)[r] ?? r);
    out.push({ id: 'intake', severity: 'note', setting: hit.map((r) => (CAP_SETTING as Record<string, string>)[r] ?? r).join(', '), message: `In the last 3 days report mail was stopped by ${names.join('; ')}. Mail from known reporters was accepted and dropped; other senders were refused. Raise the limit if this is legitimate traffic.` });
  }
  return out;
}
