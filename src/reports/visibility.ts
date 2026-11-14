// What the owner must be told besides the numbers (G5, G6, G7): reports that were stored but are not counted, and mail that reached
// the report address and could not be stored. These are API fields; the dashboard, the digest and agents render them. They exist so the
// UI never shows "no reports" (or a healthy-looking 100%) while reports were received and left out or lost.

import type { UnverifiedSummary, CountingMode, FailureRow } from '@inbox-angel/db';
import type { TenantContext } from '../tenancy/context';
import { intakeLimits } from '../hosted/config';
import { hostedEnabled } from '../hosted/config';
import { OWNER_VISIBLE, REASONS, type ReasonCode } from '../hosted/reasons';

const DAY = 86400;
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
/** How far back the owner is told about reports that could not be processed. */
export const FAILURE_WINDOW_DAYS = 14;

export interface UncountedView {
  /** Reports in the window that are not counted in the numbers (0 when every stored report counts). */
  reports: number;
  messages: number;
  latest_at: number | null;
  by_reporter: UnverifiedSummary['by_reporter'];
}

export type IntakeStatus = 'ok' | 'limited' | 'not_processed';

export interface IntakeView {
  status: IntakeStatus;
  /** Mail that reached this address and was not stored, last FAILURE_WINDOW_DAYS days. */
  not_processed: { messages: number; last_at: number | null; reasons: Array<{ reason: string; messages: number; last_at: number; text: string }> };
  /** Which limit is in force right now, if any (`limited`). */
  limit: null | 'workspace_storage' | 'instance_storage' | 'address_day' | 'workspace_day';
  /** One plain sentence for the owner, or null when all is well. */
  notice: string | null;
}

export interface ReportVisibility {
  report_counting: CountingMode;
  /** Stored reports whose sender the receiver did not prove (whatever the mode). */
  unverified: UncountedView;
  /** The part of `unverified` that is left out of the numbers (empty when report_counting is 'all'). */
  uncounted: UncountedView;
  intake: IntakeView;
}

const EMPTY: UncountedView = { reports: 0, messages: 0, latest_at: null, by_reporter: [] };

export const STORAGE_LIMIT_NOTICE = 'Report storage limit reached; newer reports are not being stored';
export const DAILY_LIMIT_NOTICE = 'Daily report limit reached for this address; newer reports are not being stored until tomorrow';

/** "3 reports from senders we could not verify are not counted." (plain, specific; used by the digest, the API and the dashboard helper). */
export const uncountedNotice = (n: number) => (n === 1 ? '1 report from a sender we could not verify is not counted.' : `${n} reports from senders we could not verify are not counted.`);

/** "3 reports could not be processed" / "1 report could not be processed". */
export const notProcessedNotice = (n: number) => `${n} ${n === 1 ? 'report' : 'reports'} received for this domain could not be processed`;

/** The text for a failure reason code, as the owner reads it. */
function reasonText(reason: string): string {
  return reason in REASONS ? REASONS[reason as ReasonCode] : reason;
}

export function intakeView(failures: FailureRow[], usage: { addressMessagesToday: number; workspaceMessagesToday: number; workspaceRecords: number; instanceRecords: number } | null, limits: ReturnType<typeof intakeLimits> | null): IntakeView {
  const rows = failures.filter((f) => OWNER_VISIBLE.has(f.reason as ReasonCode));
  const messages = rows.reduce((n, f) => n + Number(f.messages), 0);
  const last = rows.reduce<number | null>((m, f) => (m === null || f.last_at > m ? f.last_at : m), null);
  let limit: IntakeView['limit'] = null;
  if (usage && limits) {
    if (usage.workspaceRecords >= limits.workspaceRecords) limit = 'workspace_storage';
    else if (usage.instanceRecords >= limits.instanceRecords) limit = 'instance_storage';
    else if (usage.addressMessagesToday >= limits.addressMessagesPerDay) limit = 'address_day';
    else if (usage.workspaceMessagesToday >= limits.workspaceMessagesPerDay) limit = 'workspace_day';
  }
  const status: IntakeStatus = limit ? 'limited' : messages > 0 ? 'not_processed' : 'ok';
  const notice = limit === 'workspace_storage' || limit === 'instance_storage' ? STORAGE_LIMIT_NOTICE
    : limit ? DAILY_LIMIT_NOTICE
    : messages > 0 ? notProcessedNotice(messages) : null;
  return {
    status, limit, notice,
    not_processed: { messages, last_at: last, reasons: rows.map((f) => ({ reason: f.reason, messages: Number(f.messages), last_at: f.last_at, text: reasonText(f.reason) })) },
  };
}

/** Everything above for one domain: `since` (unix seconds) is the same window the numbers use. */
export async function reportVisibility(tenant: TenantContext, domainId: number, since: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<ReportVisibility> {
  const counting = tenant.scope.counting;
  const [unverified, failures, usage] = await Promise.all([
    tenant.scope.reports.unverified(domainId, since),
    tenant.scope.intake.failures(domainId, day(nowSeconds - FAILURE_WINDOW_DAYS * DAY)),
    tenant.scope.intake.usage(domainId, day(nowSeconds)),
  ]);
  return {
    report_counting: counting,
    unverified,
    uncounted: counting === 'proven' ? unverified : EMPTY,
    // The caps only apply to hosted intake; self-host has no daily caps to hit.
    intake: intakeView(failures, hostedEnabled(tenant.env) ? usage : null, hostedEnabled(tenant.env) ? intakeLimits(tenant.env) : null),
  };
}
