// What the owner setup check (src/setup/preflight.ts) says about connecting reports to the fixed address, next to the intake findings of
// src/reports/auth-status.ts (authentication, caps, dropped counted reports), which this does not repeat. Configuration only: no DNS
// lookup, no value ever echoed. Names the setting and what it breaks, like every other item there.
import type { BoundEnv } from '../index';
import { hostedConfig, hostedEnabled } from './config';
import { connectReportsSetting } from './fixed-address';

export interface ReportIntakeItem { id: 'intake'; severity: 'action' | 'note'; setting: string; message: string }

export function reportIntakePreflightItems(env: Pick<BoundEnv, 'MODE' | 'SAAS_ENABLED' | 'INTAKE_DOMAIN' | 'HOSTED_CONNECT_REPORTS' | 'OWNER_EMAIL'>): ReportIntakeItem[] {
  if (!hostedEnabled(env)) return [];
  const items: ReportIntakeItem[] = [];
  const item = (severity: ReportIntakeItem['severity'], setting: string, message: string) => items.push({ id: 'intake', severity, setting, message });
  if (!hostedConfig(env).intakeDomain) {
    item('note', 'INTAKE_DOMAIN', 'DMARC reports cannot be received: INTAKE_DOMAIN is not set. Customers see "Reports not connected yet".');
    return items;
  }
  const connect = connectReportsSetting(env);
  if (!connect.valid) item('action', 'HOSTED_CONNECT_REPORTS', 'HOSTED_CONNECT_REPORTS is neither "owner" nor "all", so it is treated as "owner".');
  // Always one line with the switch's current value (the parsed mode, never the raw setting).
  if (connect.mode === 'owner') {
    if (!env.OWNER_EMAIL?.trim()) item('action', 'HOSTED_CONNECT_REPORTS, OWNER_EMAIL', 'HOSTED_CONNECT_REPORTS is "owner": only the instance owner\'s workspaces may connect reports, but OWNER_EMAIL is not set, so nobody can.');
    else item('note', 'HOSTED_CONNECT_REPORTS', 'HOSTED_CONNECT_REPORTS is "owner": only workspaces you own can connect reports. Before setting it to "all", go through "Going from owner to all" in docs/hosted.md.');
  } else {
    item('note', 'HOSTED_CONNECT_REPORTS', 'HOSTED_CONNECT_REPORTS is "all": every verified workspace can connect reports to the shared address.');
  }
  return items;
}
