// Enrolment, unsubscribe and manual stops for the onboarding sequence.

import { funnelQueries, type LeadStatus } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import type { CheckSummary } from '../email/report-formatter';
import { sequenceEnabled } from './config';
import { SEQUENCE_DAYS } from './copy';

/** `existing`: already in the sequence and still getting it. `inactive`: known, but the sequence is finished or stopped, so they get nothing more. */
export type EnrollResult = 'enrolled' | 'existing' | 'inactive' | 'suppressed' | 'disabled';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 86400;

export const normaliseEmail = (e: string): string => e.trim().toLowerCase();

/**
 * Upsert the lead for a free check and enrol it, unless the sequence is off or the address is suppressed.
 * An address already in the sequence keeps its place (a second check refreshes the stored result, not the schedule).
 */
export async function enrollLead(
  env: BoundEnv,
  input: { email: string; domain: string; summary: CheckSummary },
  now = Math.floor(Date.now() / 1000),
): Promise<EnrollResult> {
  if (!sequenceEnabled(env)) return 'disabled';
  const email = normaliseEmail(input.email);
  if (!EMAIL_RE.test(email)) return 'disabled';
  const q = funnelQueries(env.DB);
  if (await q.suppression.has(email)) return 'suppressed';
  const outcome = await q.leads.upsert({
    email,
    domain: input.domain.toLowerCase(),
    check_level: input.summary.status,
    check_summary: JSON.stringify(input.summary),
    first_send_at: now + SEQUENCE_DAYS[0] * DAY,
    now,
  });
  if (outcome === 'created') return 'enrolled';
  return (await q.leads.byEmail(email))?.status === 'active' ? 'existing' : 'inactive';
}

/** Unsubscribe: suppress the address for good, delete its lead and its change-alert subscriptions. Idempotent. */
export async function unsubscribeEmail(env: Pick<BoundEnv, 'DB'>, rawEmail: string, reason = 'unsubscribe'): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const q = funnelQueries(env.DB);
  await q.suppression.add(email, reason);
  await q.leads.delete(email);
  await q.deleteSubscriptionsFor(email);
}

export const MANUAL_STOPS = ['replied', 'booked', 'converted'] as const satisfies readonly LeadStatus[];
export type ManualStop = (typeof MANUAL_STOPS)[number];

/** Stop the sequence for a lead because they replied, booked or bought (the owner records it; see docs/email-funnel.md). */
export async function stopLead(env: Pick<BoundEnv, 'DB'>, id: number, reason: ManualStop): Promise<boolean> {
  const q = funnelQueries(env.DB);
  if (!(await q.leads.byId(id))) return false;
  await q.leads.setStatus(id, reason);
  return true;
}
