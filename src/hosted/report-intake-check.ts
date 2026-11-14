// What the owner setup check (src/setup/preflight.ts) says about hosted report intake. Configuration only: no DNS
// lookup, no value ever echoed. Names the setting and what it breaks, like every other item there.
import type { BoundEnv } from '../index';
import { hostedConfig, hostedEnabled, intakeLimits } from './config';
import { connectReportsSetting } from './fixed-address';

export interface ReportIntakeItem { id: 'report_intake'; severity: 'action' | 'note'; setting: string; message: string }

/** The largest record count per report that stays inside D1's per-invocation query budget until large reports are batched. */
export const SAFE_RECORDS_PER_REPORT = 900;

export function reportIntakePreflightItems(env: BoundEnv): ReportIntakeItem[] {
  if (!hostedEnabled(env)) return [];
  const items: ReportIntakeItem[] = [];
  const item = (severity: ReportIntakeItem['severity'], setting: string, message: string) => items.push({ id: 'report_intake', severity, setting, message });
  if (!hostedConfig(env).intakeDomain) {
    item('note', 'INTAKE_DOMAIN', 'DMARC reports cannot be received: INTAKE_DOMAIN is not set. Customers see "Reports not connected yet".');
    return items;
  }
  const connect = connectReportsSetting(env);
  if (!connect.valid) item('action', 'HOSTED_CONNECT_REPORTS', 'HOSTED_CONNECT_REPORTS is neither "owner" nor "all", so it is treated as "owner".');
  if (connect.mode === 'owner') {
    if (!env.OWNER_EMAIL?.trim()) item('action', 'HOSTED_CONNECT_REPORTS, OWNER_EMAIL', 'Only the instance owner\'s workspaces may connect reports, but OWNER_EMAIL is not set, so nobody can.');
    else item('note', 'HOSTED_CONNECT_REPORTS', 'Only workspaces you own can connect reports. Set HOSTED_CONNECT_REPORTS to "all" to open it to every verified workspace.');
  }
  if (!env.AUTHSERV_ID?.trim() || !env.AUTHSERV_HEADER?.trim()) {
    item('note', 'AUTHSERV_ID, AUTHSERV_HEADER', 'No report can be proven to come from its reporter until both are set: every report is accepted as unproven.');
  }
  if (intakeLimits(env).recordsPerReport > SAFE_RECORDS_PER_REPORT) {
    item('note', 'INTAKE_MAX_RECORDS_PER_REPORT', `Reports with more than ${SAFE_RECORDS_PER_REPORT} records can exceed the database's per-request query limit. Set it to ${SAFE_RECORDS_PER_REPORT} or less.`);
  }
  return items;
}
