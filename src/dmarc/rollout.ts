// DMARC staged rollout helpers (RFC 9989 / DMARCbis — `pct` is removed).
// Graduation sequence: none → quarantine (t=y) → quarantine → reject (t=y) → reject.
// `t=y` is DMARCbis testing mode: receivers apply the next-weaker policy while it is set,
// which replaces the old pct= sampling as the intermediate signal. Each step is gated
// behind a pass-rate threshold to prevent mail loss.

export type RolloutPolicy = 'none' | 'quarantine' | 'reject';

export interface RolloutStep {
  policy: RolloutPolicy;
  /** t=y published on the record (testing mode). */
  testing: boolean;
}

export const ROLLOUT_SEQUENCE: RolloutStep[] = [
  { policy: 'none', testing: false },
  { policy: 'quarantine', testing: true },
  { policy: 'quarantine', testing: false },
  { policy: 'reject', testing: true },
  { policy: 'reject', testing: false },
];

// Minimum pass rate (0-100) required to advance to the next step.
export const PASS_RATE_THRESHOLD = 90;

const STRENGTH: Record<RolloutPolicy, number> = { none: 0, quarantine: 1, reject: 2 };

function asPolicy(p: string | null | undefined): RolloutPolicy | null {
  const v = p?.trim().toLowerCase();
  return v === 'none' || v === 'quarantine' || v === 'reject' ? v : null;
}

/** Splits a DMARC record into lower-cased tag → value (first occurrence wins). */
export function parseDmarcTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.replace(/^"|"$/g, '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    if (k && !tags.has(k)) tags.set(k, part.slice(eq + 1).trim());
  }
  return tags;
}

/**
 * Maps a published policy (including legacy pct= records) onto the new sequence.
 * Returns the step index, or -1 for an unrecognised policy.
 *
 * Migration rule — never weaken: a partial pct (1-99) already enforces on part of the
 * traffic, while t=y enforces on none of it, so legacy pct stages map to the *fully
 * enforced* step of the same policy and never to a testing step:
 *   p=none                       → none
 *   p=quarantine pct 1-99 or 100 → quarantine
 *   p=reject     pct 1-99 or 100 → reject
 * pct=0 is the exception: RFC 9989 Appendix A.6 defines it as equivalent to t=y, so it
 * (like an explicit t=y) maps to the testing step of the same policy.
 */
export function stepIndexFor(policy: string | null, pct: number | null = null, testing = false): number {
  const p = asPolicy(policy);
  if (p === null) return policy === null ? 0 : -1;
  if (p === 'none') return 0;
  // A partial pct (legacy) always wins over t=y: sampled enforcement must not be downgraded.
  const partial = pct != null && pct > 0 && pct < 100;
  const isTesting = pct === 0 || (testing && !partial);
  return ROLLOUT_SEQUENCE.findIndex((s) => s.policy === p && s.testing === isTesting);
}

/** Step index for a live DMARC TXT record, or -1 if p= is unrecognised. */
export function stepIndexForRecord(record: string): number {
  const tags = parseDmarcTags(record);
  const pct = tags.has('pct') ? parseInt(tags.get('pct')!, 10) : null;
  return stepIndexFor(tags.get('p') ?? null, Number.isNaN(pct) ? null : pct, tags.get('t')?.toLowerCase() === 'y');
}

/**
 * Persistence: the domains table has no `testing` column, so the stored recommendation uses
 * rollout_rec_pct as a marker — 0 = testing (t=y), 100 = enforced. Legacy rows (10/50/100)
 * are read through stepIndexFor, so they migrate without a schema change.
 */
export function toStored(step: RolloutStep): { policy: string; pct: number } {
  return { policy: step.policy, pct: step.testing ? 0 : 100 };
}

export function stepIndexFromStored(policy: string | null, pct: number | null): number {
  if (!policy || pct == null) return -1;
  return pct === 0 ? stepIndexFor(policy, null, true) : stepIndexFor(policy, pct);
}

/** Returns the step after the given one, or null when already at the last step / unrecognised. */
export function getNextStep(policy: string | null, pct: number | null = null, testing = false): RolloutStep | null {
  const i = stepIndexFor(policy, pct, testing);
  if (i === -1 || i === ROLLOUT_SEQUENCE.length - 1) return null;
  return ROLLOUT_SEQUENCE[i + 1];
}

/** Current step index (0-based) in ROLLOUT_SEQUENCE; 0 = not started (p=none), -1 = unrecognised. */
export function getCurrentStepIndex(policy: string | null, pct: number | null = null, testing = false): number {
  return stepIndexFor(policy, pct, testing);
}

export function describeStep(step: RolloutStep): string {
  return step.testing ? `p=${step.policy}; t=y` : `p=${step.policy}`;
}

const rank = (p: RolloutPolicy) => STRENGTH[p];
const lower = (p: RolloutPolicy): RolloutPolicy => (p === 'reject' ? 'quarantine' : 'none');

/** Effective published p/sp/np, honouring inheritance: np ← sp ← p. */
function effectivePolicies(tags: Map<string, string>): { p: RolloutPolicy; sp: RolloutPolicy; np: RolloutPolicy } {
  const p = asPolicy(tags.get('p')) ?? 'none';
  const sp = asPolicy(tags.get('sp')) ?? p;
  const np = asPolicy(tags.get('np')) ?? sp;
  return { p, sp, np };
}

/**
 * RFC 9989: t=y applies to p, sp and np alike — receivers treat each one step weaker.
 * A testing step therefore weakens any surface (p, sp or np) that is currently published
 * above lower(step.policy), e.g. p=none; sp=reject → p=quarantine; t=y turns sp=reject
 * into quarantine behaviour.
 */
export function testingWouldWeaken(existingRecord: string, step: RolloutStep): boolean {
  if (!step.testing) return false;
  const eff = effectivePolicies(parseDmarcTags(existingRecord));
  const floor = rank(lower(step.policy));
  return rank(eff.p) > floor || rank(eff.sp) > floor || rank(eff.np) > floor;
}

export interface NextStepPlan {
  step: RolloutStep;
  /** The live record carries a partial pct=; applying the step drops it (RFC 9989). */
  dropsPartialPct: boolean;
  /** The natural t=y step was skipped because it would weaken a stricter sp=/np=. */
  skippedTesting: boolean;
  /** Human-readable caveat for the UI, or null when the step is a plain advance. */
  note: string | null;
}

/**
 * Picks the next step for a live record (null → no record yet). Differs from the bare
 * sequence in two safety cases, both so applying the step never weakens the record:
 *  - partial pct= (legacy): the next step is the same policy fully enforced ("quarantine (full)"),
 *    because dropping pct= applies the policy to 100% of failing mail — we say so instead of
 *    presenting it as a testing step.
 *  - a testing step that would weaken a stricter sp=/np=: skipped, going straight to the
 *    enforced step of the same policy (still behind the normal pass-rate gate).
 */
export function planNextStep(record: string | null): NextStepPlan | null {
  if (record === null) return { step: ROLLOUT_SEQUENCE[1], dropsPartialPct: false, skippedTesting: false, note: null };
  const idx = stepIndexForRecord(record);
  if (idx === -1) return null;
  const tags = parseDmarcTags(record);
  const pct = tags.has('pct') ? parseInt(tags.get('pct')!, 10) : NaN;
  const current = ROLLOUT_SEQUENCE[idx];
  if (current.policy !== 'none' && pct > 0 && pct < 100) {
    return {
      step: current,
      dropsPartialPct: true,
      skippedTesting: false,
      note: `Removes pct=${pct} (dropped by RFC 9989): ${current.policy} will apply to 100% of failing mail.`,
    };
  }
  if (idx === ROLLOUT_SEQUENCE.length - 1) return null;
  const candidate = ROLLOUT_SEQUENCE[idx + 1];
  if (testingWouldWeaken(record, candidate)) {
    return {
      step: ROLLOUT_SEQUENCE[idx + 2],
      dropsPartialPct: false,
      skippedTesting: true,
      note: `Skipping the t=y step: a stricter sp=/np= is already published and t=y would weaken it. Goes straight to ${candidate.policy}.`,
    };
  }
  return { step: candidate, dropsPartialPct: false, skippedTesting: false, note: null };
}

/**
 * Builds the DMARC TXT record for a step, preserving other tags (rua=, ruf=, adkim=, …).
 * Sets p=, sp= and np= explicitly, sets or removes t=, and drops pct= (removed by RFC 9989).
 * sp/np follow the step's policy but never weaken an existing stricter *effective* sp=/np=
 * (an absent np inherits sp, which inherits p). Throws if a testing step (t=y) would weaken
 * a stricter published policy — see testingWouldWeaken / planNextStep.
 */
export function buildStepRecord(existingRecord: string, step: RolloutStep): string {
  if (testingWouldWeaken(existingRecord, step)) {
    throw new Error(`t=y step ${step.policy} would weaken a stricter published p=/sp=/np=`);
  }
  const eff = effectivePolicies(parseDmarcTags(existingRecord));
  const keepStricter = (tag: 'sp' | 'np'): RolloutPolicy => (rank(eff[tag]) > rank(step.policy) ? eff[tag] : step.policy);

  const out: [string, string][] = [['v', 'DMARC1'], ['p', step.policy], ['sp', keepStricter('sp')], ['np', keepStricter('np')]];
  if (step.testing) out.push(['t', 'y']);

  const managed = new Set(['v', 'p', 'sp', 'np', 't', 'pct']);
  const rest = existingRecord.replace(/^"|"$/g, '').split(';')
    .map((s) => s.trim()).filter(Boolean)
    .filter((part) => !managed.has(part.split('=')[0].trim().toLowerCase()));

  return [...out.map(([k, v]) => `${k}=${v}`), ...rest].join('; ');
}
