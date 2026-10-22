// Enforcement readiness: is it safe to take the next RFC 9989 step (none → quarantine; t=y → quarantine →
// reject; t=y → reject)? The answer comes with its reasons, each tagged so the UI never relies on colour.
//
// The step itself is never decided here: where we are and what comes next come from src/dmarc/rollout.ts
// (`stepIndexForRecord` / `stepIndexFromStored` and `planNextStep`), the same functions rollout-next uses, so the
// two cannot disagree (legacy pct=, t=y, a stricter sp=/np= that makes the t=y step skip).
//
// Only the reports' own pass/fail totals can block. Per-sender alignment is estimated (see senders.ts), so what it
// finds (a recognised service that seems to fail) can only warn.

import {
  describeStep, PASS_RATE_THRESHOLD, planNextStep, ROLLOUT_SEQUENCE, stepIndexForRecord, stepIndexFromStored, type NextStepPlan, type RolloutStep,
} from '../dmarc/rollout';
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

/** Where the domain stands: the live DMARC record (null = none published), or what we last stored. */
export type PolicyState = { record: string | null } | { policy: string | null; pct: number | null };

export interface ReadinessInput {
  state: PolicyState;
  messages: number;
  passed: number;
  daysWithReports: number;
  windowDays: number;
  fixes: Fix[];
  newSenders: number;
  /** A subdomain with no record of its own: it follows its parent, so "no record" is not a gap here. */
  inherits?: boolean;
}

/**
 * The stored policy and pct as the record they stand for. pct=0 is the stored marker for testing mode (rollout.ts
 * `toStored`), which is t=y; a partial pct stays a legacy pct=. Anything we cannot know (sp=, np=) is absent, so a
 * stored state can miss the sp/np skip that a live record would trigger; `policy_source` tells the reader which it was.
 */
export function recordFromStored(policy: string | null, pct: number | null): string | null {
  if (!policy) return null;
  const tags = [`v=DMARC1`, `p=${policy}`];
  if (policy !== 'none') {
    if (pct === 0) tags.push('t=y');
    else if (pct != null && pct > 0 && pct < 100) tags.push(`pct=${pct}`);
  }
  return tags.join('; ');
}

/** Current step index and the plan for the next one, exactly as rollout-next computes them. */
export function resolveStep(state: PolicyState): { record: string | null; index: number; plan: NextStepPlan | null } {
  const record = 'record' in state ? state.record : recordFromStored(state.policy, state.pct);
  if (record === null) return { record, index: 0, plan: planNextStep(null) };
  const index = 'record' in state ? stepIndexForRecord(record) : stepIndexFromStored(state.policy, state.pct ?? 100);
  return { record, index, plan: planNextStep(record) };
}

export function assessReadiness(i: ReadinessInput): Readiness {
  const { record, index, plan } = resolveStep(i.state);
  const rate = i.messages > 0 ? pct(i.passed, i.messages) : null;
  const metrics = { messages: i.messages, pass_rate: rate, days_with_reports: i.daysWithReports, window_days: i.windowDays };
  const step = ROLLOUT_SEQUENCE[Math.max(index, 0)] as RolloutStep;
  const policy = record === null ? null : step.policy;
  const current = { policy, testing: record !== null && step.testing, step: Math.max(index, 0), label: record === null ? 'no DMARC record' : index === -1 ? 'unrecognised policy' : describeStep(step) };
  const done = (status: ReadinessStatus, headline: string, reasons: Reason[], next: RolloutStep | null): Readiness => ({
    status, headline, current, total_steps: ROLLOUT_SEQUENCE.length, metrics, reasons,
    next: next ? { policy: next.policy, testing: next.testing, label: describeStep(next) } : null,
  });

  if (record === null && i.inherits) {
    return done('no_policy', 'Follows the parent domain\'s policy', [{ level: 'warn', text: 'This subdomain has no DMARC record of its own, so it inherits its parent\'s policy. Assess and change that on the parent domain.' }], null);
  }
  if (record === null) {
    return done('no_policy', 'Publish a DMARC record first', [{ level: 'block', text: 'There is no DMARC record, so no reports can arrive and nothing is enforced. Start with p=none.' }], plan?.step ?? null);
  }
  if (index === -1) {
    return done('blocked', 'The published policy is not one we can step from', [{ level: 'block', text: 'The p= value is not a recognised policy.' }], null);
  }
  if (!plan) {
    return done('complete', 'Fully enforced', [{ level: 'ok', text: 'DMARC is at p=reject without testing mode. There is no next step.' }], null);
  }

  const next = plan.step;
  const enforcing = !next.testing; // t=y asks receivers to treat failures as one step weaker, so it is the safer half-step
  const reasons: Reason[] = [];
  let blocked = false;
  let caution = false;
  const block = (text: string) => { blocked = true; reasons.push({ level: 'block', text }); };
  const warn = (text: string) => { caution = true; reasons.push({ level: 'warn', text }); };

  if (plan.note) {
    if (plan.dropsPartialPct) warn(plan.note);
    else reasons.push({ level: 'ok', text: plan.note });
  }

  if (i.messages < MIN_MESSAGES || i.daysWithReports < MIN_DAYS_WITH_REPORTS) {
    const have = `${i.messages.toLocaleString('en-US')} messages over ${i.daysWithReports} day${i.daysWithReports === 1 ? '' : 's'} with reports`;
    return done('insufficient_data', 'Not enough data to judge yet',
      [...reasons, { level: 'block', text: `Only ${have} in the last ${i.windowDays} days. Wait for at least ${MIN_MESSAGES} messages over ${MIN_DAYS_WITH_REPORTS} days, so every regular sender has shown up.` }], next);
  }
  reasons.push({ level: 'ok', text: `${i.messages.toLocaleString('en-US')} messages over ${i.daysWithReports} days with reports in the last ${i.windowDays} days.` });

  // The only blocker: the reports' own totals, the same threshold rollout-next uses.
  if (rate !== null && rate < PASS_RATE_THRESHOLD) block(`${rate}% of mail passes DMARC; the rollout needs at least ${PASS_RATE_THRESHOLD}%.`);
  else if (rate !== null && rate < READY_PASS_RATE) warn(`${rate}% of mail passes DMARC. ${READY_PASS_RATE}% or more is a clean signal; the remainder is what ${enforcing ? 'would be quarantined or rejected' : 'testing mode would flag'}.`);
  else if (rate !== null) reasons.push({ level: 'ok', text: `${rate}% of mail passes DMARC.` });

  // Estimated per-sender findings advise; they never block.
  const known = i.fixes.filter((f) => f.sender.provider_id && f.kind === 'authorize-sender');
  for (const f of known) warn(`${f.sender.name} seems to fail DMARC on about ${f.affected_pct}% of your mail (estimated from the reports). ${enforcing ? 'Check it before enforcing.' : 'Look at it before enforcing.'}`);
  const unknown = i.fixes.filter((f) => f.kind === 'investigate-sender');
  for (const f of unknown) warn(`${f.sender.name} sends ${f.share_pct}% of your mail and seems to fail DMARC (estimated). Confirm whether it is yours.`);

  if (i.newSenders > 0) warn(`${i.newSenders} sender${i.newSenders === 1 ? ' is' : 's are'} new this week. Give them time to show up in the reports before tightening.`);
  if (!known.length && !unknown.length) reasons.push({ level: 'ok', text: 'No recognised service seems to fail DMARC.' });

  if (!enforcing) reasons.push({ level: 'ok', text: `${describeStep(next)} is testing mode: receivers treat failures one step weaker, so it is a low-risk half-step.` });

  if (blocked) return done('blocked', `Not safe to move to ${describeStep(next)} yet`, reasons, next);
  if (caution) return done('caution', `You can move to ${describeStep(next)}, with care`, reasons, next);
  return done('ready', `Safe to move to ${describeStep(next)}`, reasons, next);
}
