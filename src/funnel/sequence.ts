// The onboarding sequence engine: one step per due lead per run.
//
// A lead's `step` is how many emails it has had; `next_send_at` is when the next is due. A run marks the step as sent
// BEFORE sending it (compare-and-set on step and due time), so a repeated or overlapping run, or a crash right after the
// provider accepted the mail, can never send a step twice. The price: a crash or an ambiguous failure can lose that one
// email, which is the right way round for marketing mail. A lead that is far behind gets one email per run, about a day apart.

import { funnelQueries, globalQueries, type LeadRow } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import { buildLetterHtml, buildLetterText } from '../email/html-templates';
import type { CheckSummary } from '../email/report-formatter';
import { DEFAULT_BRAND_COLOR } from '../tenancy/context';
import { sendNonTransactional } from '../mail/compliance';
import { funnelMailer, providerProblem, type Mailer } from '../mail/mailer';
import { bookingUrl, funnelSender, postalAddress, publicBaseUrl, sequenceEnabled, servicePrices } from './config';
import { SEQUENCE_DAYS, stepCopy } from './copy';

const DAY = 86400;
/** Catch-up spacing: a day, minus slack so a cron tick that fires a few seconds earlier than yesterday's still finds the lead due. */
const CATCH_UP_SECONDS = DAY - 3600;
const MAX_PER_RUN = 100;

export interface Readiness {
  enabled: boolean;
  /** Empty when the sequence can send. Each entry is a sentence for the dashboard. */
  blockers: string[];
  /** Things that do not stop sending but Max should know. */
  warnings: string[];
}

export function readiness(env: BoundEnv): Readiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const enabled = sequenceEnabled(env);
  if (!enabled) return { enabled, blockers: ['The sequence is off (self-host: set ONBOARDING_SEQUENCE_ENABLED=1)'], warnings };
  const provider = providerProblem(env);
  if (provider) blockers.push(provider);
  if (!funnelSender(env)) blockers.push('No sender address: set MAIL_FROM');
  if (!publicBaseUrl(env)) blockers.push('PUBLIC_BASE_URL is not set, so mail cannot carry an unsubscribe link');
  if (!postalAddress(env)) blockers.push('POSTAL_ADDRESS is not set (required in the footer of marketing email)');
  if (!env.AUTHSERV_ID?.trim() || !['ar', 'arc'].includes(env.AUTHSERV_HEADER?.trim().toLowerCase() ?? '')) warnings.push('AUTHSERV_ID and AUTHSERV_HEADER are not both set: no sender is enrolled until they are (see docs/email-funnel.md)');
  if (!bookingUrl(env)) warnings.push('BOOKING_URL is not set: the day-14 email is held until it is');
  if (Object.keys(servicePrices(env)).length === 0) warnings.push('SERVICE_PRICES is not set: the day-10 email goes out without prices');
  if (!env.MAIL_REPLY_TO) warnings.push('MAIL_REPLY_TO is not set: replies go to the sender address');
  return { enabled, blockers, warnings };
}

export interface RunResult { sent: number; held: number; stopped: number; failed: number }

/** When step `index` is due for a lead enrolled at `createdAt`; a catch-up is never sooner than ~a day after `now`. */
export function nextDue(createdAt: number, index: number, now: number): number | null {
  if (index >= SEQUENCE_DAYS.length) return null;
  return Math.max(createdAt + SEQUENCE_DAYS[index] * DAY, now + CATCH_UP_SECONDS);
}

function parseSummary(lead: LeadRow): Partial<CheckSummary> | null {
  try { return lead.check_summary ? (JSON.parse(lead.check_summary) as Partial<CheckSummary>) : null; } catch { return null; }
}

export async function runOnboardingSequence(
  env: BoundEnv,
  now = Math.floor(Date.now() / 1000),
  opts: { mailer?: Mailer | null; limit?: number } = {},
): Promise<RunResult> {
  const result: RunResult = { sent: 0, held: 0, stopped: 0, failed: 0 };
  const r = readiness(env);
  const mailer = opts.mailer === undefined ? funnelMailer(env) : opts.mailer;
  const sender = funnelSender(env);
  // Not ready: leads stay queued, nothing is sent (the dashboard says why).
  if (!r.enabled || r.blockers.length > 0 || !mailer || !sender) return result;

  const q = funnelQueries(env.DB);
  const prices = servicePrices(env);
  const booking = bookingUrl(env);
  for (const lead of await q.leads.due(now, opts.limit ?? MAX_PER_RUN)) {
    let advanced = false;
    let settled = false; // the provider's answer has been dealt with
    try {
      // Stop conditions that can be read from our own data.
      if (await q.suppression.has(lead.email)) { await q.leads.delete(lead.email); result.stopped++; continue; }
      if (await globalQueries(env.DB).users.byEmail(lead.email)) { await q.leads.setStatus(lead.id, 'converted'); result.stopped++; continue; }

      const copy = stepCopy(lead.step, { domain: lead.domain, summary: parseSummary(lead), bookingUrl: booking, prices });
      if (copy.needsBookingUrl && !booking) {
        // Held: push it a day out, or held leads (oldest first) would fill every batch and starve the rest.
        await q.leads.release(lead.id, now + DAY);
        result.held++;
        continue;
      }

      // Mark the step sent first; whoever does not win this has nothing to do.
      const next = nextDue(lead.created_at, lead.step + 1, now);
      if (!(await q.leads.advance(lead.id, lead.step, next, now))) continue;
      advanced = true;

      const out = await sendNonTransactional(env, mailer, {
        from: copy.fromName ? { ...sender, name: copy.fromName } : sender,
        to: lead.email,
        subject: copy.subject,
        text: buildLetterText(copy.blocks),
        html: buildLetterHtml({ title: copy.subject, blocks: copy.blocks, brand: { color: DEFAULT_BRAND_COLOR } }),
        replyTo: env.MAIL_REPLY_TO?.trim() || undefined,
        idempotencyKey: `lead-${lead.id}-step-${lead.step}`,
      }, { requireLink: true });

      settled = true;
      if (out.ok) {
        result.sent++;
      } else if (out.kind === 'suppressed') {
        await q.leads.delete(lead.email); result.stopped++;
      } else if (out.kind === 'recipient') {
        await q.leads.setStatus(lead.id, 'bounced');
        await q.suppression.add(lead.email, 'bounce');
        result.stopped++;
      } else if (out.kind === 'config' || out.kind === 'blocked') {
        // Definitely not sent (bad key, rejected header, no link): put the step back and stop the run, or every lead in
        // the batch would lose its email to the same fault.
        await q.leads.restore(lead.id, lead.step + 1, lead.step, lead.next_send_at ?? now, lead.last_sent_at);
        console.error(`[funnel] run stopped, lead ${lead.id} step ${lead.step} not sent (${out.kind}): ${out.error}`);
        result.failed++;
        break;
      } else {
        // Transient and possibly ambiguous (a timeout may have been delivered): the step stays marked sent, so at worst
        // this one email is missed. Stop the run: the provider is struggling.
        console.error(`[funnel] run stopped, lead ${lead.id} step ${lead.step} may be missed (${out.kind}): ${out.error}`);
        result.failed++;
        break;
      }
    } catch (e) {
      // An internal error (a database or code fault), not a provider answer. If the step was marked but the provider never
      // answered (the fault came before or around the send), put it back and stop: it is not a transient send failure.
      console.error(`[funnel] run stopped, internal error on lead ${lead.id}:`, e instanceof Error ? e.message : 'error');
      if (advanced && !settled) {
        await q.leads.restore(lead.id, lead.step + 1, lead.step, lead.next_send_at ?? now, lead.last_sent_at).catch(() => {});
      }
      result.failed++;
      break;
    }
  }
  return result;
}
