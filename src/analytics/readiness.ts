// Enforcement readiness: is it safe to take the next RFC 9989 step (none → quarantine; t=y → quarantine →
// reject; t=y → reject)? The answer comes with its reasons, each tagged so the UI never relies on colour.
//
// Stricter than the rollout API, which only blocks below PASS_RATE_THRESHOLD: this also wants enough data, a
// clean 30 days, and no recognised service failing. Those extra checks only advise; the rollout stays in charge.

import { describeStep, PASS_RATE_THRESHOLD, ROLLOUT_SEQUENCE, stepIndexFor, type RolloutStep } from '../dmarc/rollout';
import type { Fix } from './fixes';
import { pct } from './senders';

export type ReadinessStatus = 'ready' | 'caution' | 'blocked' | 'insufficient_data' | 'complete' | 'no_policy';
export type ReasonLevel = 'ok' | 'warn' | 'block';

export interface Reason {
  level: ReasonLevel;
  text: string;
}

export interface Readiness {
  status: ReadinessStatus;
  headline: string;
  current: { policy: string | null; testing: boolean; step: number; label: string };
  next: { policy: string; testing: boolean; label: string } | null;
  total_steps: number;
  reasons: Reason[];
  metrics: { messages: number; pass_rate: number | null; days_with_reports: number; window_days: number };
}

/** Enough mail and enough days to judge from. */
export const MIN_MESSAGES = 100;
export const MIN_DAYS_WITH_REPORTS = 7;
/** At or above this a clean pass rate is "ready"; between PASS_RATE_THRESHOLD and this it is "caution". */
export const READY_PASS_RATE = 98;

export interface ReadinessInput {
  policy: string | null;
  testing: boolean;
  messages: number;
  passed: number;
  daysWithReports: number;
  windowDays: number;
  fixes: Fix[];
  newSenders: number;
  /** A subdomain with no record of its own: it follows its parent, so "no record" is not a gap here. */
  inherits?: boolean;
}

export function assessReadiness(i: ReadinessInput): Readiness {
  const idx = i.policy === null ? -1 : stepIndexFor(i.policy, null, i.testing);
  const last = ROLLOUT_SEQUENCE.length - 1;
  const rate = i.messages > 0 ? pct(i.passed, i.messages) : null;
  const metrics = { messages: i.messages, pass_rate: rate, days_with_reports: i.daysWithReports, window_days: i.windowDays };
  const current = { policy: i.policy, testing: i.testing, step: Math.max(idx, 0), label: i.policy ? describeStep({ policy: i.policy as RolloutStep['policy'], testing: i.testing }) : 'no DMARC record' };
  const done = (status: ReadinessStatus, headline: string, reasons: Reason[], next: RolloutStep | null): Readiness => ({
    status, headline, current, total_steps: ROLLOUT_SEQUENCE.length, metrics, reasons,
    next: next ? { policy: next.policy, testing: next.testing, label: describeStep(next) } : null,
  });

  if (i.policy === null && i.inherits) {
    return done('no_policy', 'Follows the parent domain\'s policy', [{ level: 'warn', text: 'This subdomain has no DMARC record of its own, so it inherits its parent\'s policy. Assess and change that on the parent domain.' }], null);
  }
  if (i.policy === null) {
    return done('no_policy', 'Publish a DMARC record first', [{ level: 'block', text: 'There is no DMARC record, so no reports can arrive and nothing is enforced. Start with p=none.' }], ROLLOUT_SEQUENCE[0] ?? null);
  }
  if (idx === -1) {
    return done('blocked', 'The published policy is not one we can step from', [{ level: 'block', text: `p=${i.policy} is not a recognised policy.` }], null);
  }
  if (idx === last) {
    return done('complete', 'Fully enforced', [{ level: 'ok', text: 'DMARC is at p=reject without testing mode. There is no next step.' }], null);
  }

  const next = ROLLOUT_SEQUENCE[idx + 1] as RolloutStep;
  const enforcing = !next.testing; // t=y asks receivers to treat failures as one step weaker, so it is the safer half-step
  const reasons: Reason[] = [];
  let blocked = false;
  let caution = false;
  const block = (text: string) => { blocked = true; reasons.push({ level: 'block', text }); };
  const warn = (text: string) => { caution = true; reasons.push({ level: 'warn', text }); };

  if (i.messages < MIN_MESSAGES || i.daysWithReports < MIN_DAYS_WITH_REPORTS) {
    const have = `${i.messages.toLocaleString('en-US')} messages over ${i.daysWithReports} day${i.daysWithReports === 1 ? '' : 's'} with reports`;
    return done('insufficient_data', 'Not enough data to judge yet',
      [{ level: 'block', text: `Only ${have} in the last ${i.windowDays} days. Wait for at least ${MIN_MESSAGES} messages over ${MIN_DAYS_WITH_REPORTS} days, so every regular sender has shown up.` }], next);
  }
  reasons.push({ level: 'ok', text: `${i.messages.toLocaleString('en-US')} messages over ${i.daysWithReports} days with reports in the last ${i.windowDays} days.` });

  if (rate !== null && rate < PASS_RATE_THRESHOLD) block(`${rate}% of mail passes DMARC; the rollout needs at least ${PASS_RATE_THRESHOLD}%.`);
  else if (rate !== null && rate < READY_PASS_RATE) warn(`${rate}% of mail passes DMARC. ${READY_PASS_RATE}% or more is a clean signal; the remainder is what ${enforcing ? 'would be quarantined or rejected' : 'testing mode would flag'}.`);
  else if (rate !== null) reasons.push({ level: 'ok', text: `${rate}% of mail passes DMARC.` });

  const known = i.fixes.filter((f) => f.sender.provider_id && (f.kind === 'authorize-sender'));
  for (const f of known) {
    const text = `${f.sender.name} fails DMARC on ${f.affected_pct}% of your mail. ${enforcing ? 'Enforcement would block it.' : 'Fix it before enforcing.'}`;
    if (enforcing) block(text); else warn(text);
  }
  const unknown = i.fixes.filter((f) => f.kind === 'investigate-sender');
  for (const f of unknown) warn(`${f.sender.name} sends ${f.share_pct}% of your mail and fails DMARC. Confirm whether it is yours.`);

  if (i.newSenders > 0) warn(`${i.newSenders} sender${i.newSenders === 1 ? ' is' : 's are'} new this week. Give them time to show up in the reports before tightening.`);
  if (!known.length && !unknown.length) reasons.push({ level: 'ok', text: 'No recognised service is failing DMARC.' });

  if (!enforcing) reasons.push({ level: 'ok', text: `${describeStep(next)} is testing mode: receivers treat failures one step weaker, so it is a low-risk half-step.` });

  if (blocked) return done('blocked', `Not safe to move to ${describeStep(next)} yet`, reasons, next);
  if (caution) return done('caution', `You can move to ${describeStep(next)}, with care`, reasons, next);
  return done('ready', `Safe to move to ${describeStep(next)}`, reasons, next);
}
