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
 * Migration rule — never weaken: a partial pct (<100) already enforces on part of the
 * traffic, while t=y enforces on none of it, so legacy pct stages map to the *fully
 * enforced* step of the same policy and never to a testing step:
 *   p=none                       → none
 *   p=quarantine pct<100 or 100  → quarantine
 *   p=reject     pct<100 or 100  → reject
 * An explicit t=y (new-style record) maps to the testing step.
 */
export function stepIndexFor(policy: string | null, pct: number | null = null, testing = false): number {
  const p = asPolicy(policy);
  if (p === null) return policy === null ? 0 : -1;
  if (p === 'none') return 0;
  // pct present (legacy) always wins over testing: sampled enforcement must not be downgraded.
  const legacy = pct != null && pct < 100;
  return ROLLOUT_SEQUENCE.findIndex((s) => s.policy === p && s.testing === (testing && !legacy));
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

/**
 * Builds the DMARC TXT record for a step, preserving other tags (rua=, ruf=, adkim=, …).
 * Sets p=, sp= and np= explicitly, sets or removes t=, and drops pct= (removed by RFC 9989).
 * sp/np follow the step's policy but never weaken an existing stricter sp=/np=.
 */
export function buildStepRecord(existingRecord: string, step: RolloutStep): string {
  const existing = parseDmarcTags(existingRecord);
  const keepStricter = (tag: 'sp' | 'np'): RolloutPolicy => {
    const prev = asPolicy(existing.get(tag));
    return prev && STRENGTH[prev] > STRENGTH[step.policy] ? prev : step.policy;
  };

  const out: [string, string][] = [['v', 'DMARC1'], ['p', step.policy], ['sp', keepStricter('sp')], ['np', keepStricter('np')]];
  if (step.testing) out.push(['t', 'y']);

  const managed = new Set(['v', 'p', 'sp', 'np', 't', 'pct']);
  const rest = existingRecord.replace(/^"|"$/g, '').split(';')
    .map((s) => s.trim()).filter(Boolean)
    .filter((part) => !managed.has(part.split('=')[0].trim().toLowerCase()));

  return [...out.map(([k, v]) => `${k}=${v}`), ...rest].join('; ');
}
