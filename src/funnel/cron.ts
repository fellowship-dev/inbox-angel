// Cron jobs of the email funnel. Called from src/cron.ts, one line each.

import { funnelQueries } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import type { TenantContext } from '../tenancy/context';
import { runOnboardingSequence } from './sequence';

const DAY = 86400;
/** Leads are deleted 12 months after their last activity (and at once on unsubscribe, see unsubscribeEmail). */
export const LEAD_RETENTION_SECONDS = 365 * DAY;
/** A monitor subscription nobody confirmed is deleted after this long. */
export const MONITOR_CONFIRM_WINDOW_SECONDS = 7 * DAY;

/** Global funnel work, once per cron tick (not per workspace): the sequence run, then lead retention. */
export async function runFunnelCron(event: Pick<ScheduledController, 'cron'>, env: BoundEnv, now = Math.floor(Date.now() / 1000)): Promise<void> {
  if (event.cron !== '0 8 * * *') return;
  try {
    const r = await runOnboardingSequence(env, now);
    if (r.sent || r.stopped || r.failed || r.held) console.log(`[funnel] sequence: sent ${r.sent}, held ${r.held}, stopped ${r.stopped}, failed ${r.failed}`);
  } catch (e) {
    console.error('[funnel] sequence run failed:', e instanceof Error ? e.message : 'error');
  }
  try {
    const deleted = await funnelQueries(env.DB).leads.deleteInactiveBefore(now - LEAD_RETENTION_SECONDS);
    if (deleted) console.log(`[funnel] retention: deleted ${deleted} leads inactive for 12 months`);
  } catch (e) {
    console.error('[funnel] lead retention failed:', e instanceof Error ? e.message : 'error');
  }
}

/** Double opt-in expiry: unconfirmed change-alert subscriptions older than 7 days go. */
export async function expireUnconfirmedMonitors(tenant: TenantContext, now = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    const deleted = await tenant.scope.monitor.deleteUnconfirmedBefore(now - MONITOR_CONFIRM_WINDOW_SECONDS);
    if (deleted) console.log(`[monitor] expired ${deleted} unconfirmed subscriptions`);
  } catch (e) {
    console.error('[monitor] expiry failed:', e instanceof Error ? e.message : 'error');
  }
}
