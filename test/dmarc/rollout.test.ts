import { describe, it, expect } from 'vitest';
import {
  ROLLOUT_SEQUENCE,
  getNextStep,
  getCurrentStepIndex,
  buildStepRecord,
  stepIndexFor,
  stepIndexForRecord,
  stepIndexFromStored,
  toStored,
  parseDmarcTags,
  testingWouldWeaken,
  planNextStep,
} from '../../src/dmarc/rollout';
import { detectRollbackRisk, ROLLBACK_THRESHOLD_PP } from '../../src/monitor/check';

const NONE = { policy: 'none', testing: false };
const Q_T = { policy: 'quarantine', testing: true };
const Q = { policy: 'quarantine', testing: false };
const R_T = { policy: 'reject', testing: true };
const R = { policy: 'reject', testing: false };

describe('ROLLOUT_SEQUENCE', () => {
  it('is none → quarantine(t=y) → quarantine → reject(t=y) → reject', () => {
    expect(ROLLOUT_SEQUENCE).toEqual([NONE, Q_T, Q, R_T, R]);
  });
});

describe('getNextStep (each transition)', () => {
  it('none → quarantine t=y', () => {
    expect(getNextStep('none')).toEqual(Q_T);
    expect(getNextStep(null)).toEqual(Q_T);
  });
  it('quarantine t=y → quarantine', () => expect(getNextStep('quarantine', null, true)).toEqual(Q));
  it('quarantine → reject t=y', () => expect(getNextStep('quarantine')).toEqual(R_T));
  it('reject t=y → reject', () => expect(getNextStep('reject', null, true)).toEqual(R));
  it('reject is terminal', () => expect(getNextStep('reject')).toBeNull());
  it('unrecognised policy has no next step', () => expect(getNextStep('bogus')).toBeNull());
});

describe('getCurrentStepIndex', () => {
  it('indexes the sequence', () => {
    expect(getCurrentStepIndex('none')).toBe(0);
    expect(getCurrentStepIndex(null)).toBe(0);
    expect(getCurrentStepIndex('quarantine', null, true)).toBe(1);
    expect(getCurrentStepIndex('quarantine')).toBe(2);
    expect(getCurrentStepIndex('reject', null, true)).toBe(3);
    expect(getCurrentStepIndex('reject')).toBe(4);
    expect(getCurrentStepIndex('bogus')).toBe(-1);
  });
});

describe('legacy pct= migration mapping', () => {
  it('maps every legacy stage to a fully enforced step of the same policy', () => {
    expect(stepIndexFor('quarantine', 10)).toBe(2);
    expect(stepIndexFor('quarantine', 50)).toBe(2);
    expect(stepIndexFor('quarantine', 100)).toBe(2);
    expect(stepIndexFor('reject', 10)).toBe(4);
    expect(stepIndexFor('reject', 50)).toBe(4);
    expect(stepIndexFor('reject', 100)).toBe(4);
    expect(stepIndexFor('none', 100)).toBe(0);
  });

  it('never maps a policy to a weaker one, or onto a testing step', () => {
    const strength = { none: 0, quarantine: 1, reject: 2 } as const;
    for (const policy of ['none', 'quarantine', 'reject'] as const) {
      for (const pct of [1, 10, 50, 99, 100, null]) {
        const step = ROLLOUT_SEQUENCE[stepIndexFor(policy, pct)];
        expect(strength[step.policy]).toBeGreaterThanOrEqual(strength[policy]);
        if (policy !== 'none') expect(step.testing).toBe(false);
      }
    }
  });

  it('a partial pct beats t=y (sampled enforcement is not downgraded to testing)', () => {
    expect(stepIndexFor('quarantine', 50, true)).toBe(2);
  });

  it('reads live records, legacy and new', () => {
    expect(stepIndexForRecord('v=DMARC1; p=quarantine; pct=10; rua=mailto:a@b.c')).toBe(2);
    expect(stepIndexForRecord('"v=DMARC1; p=reject; pct=50"')).toBe(4);
    expect(stepIndexForRecord('v=DMARC1; p=quarantine; t=y')).toBe(1);
    expect(stepIndexForRecord('v=DMARC1; p=reject; sp=reject; np=reject; t=y')).toBe(3);
    expect(stepIndexForRecord('v=DMARC1; p=none')).toBe(0);
    expect(stepIndexForRecord('v=DMARC1; p=weird')).toBe(-1);
  });

  it('an sp= tag is not mistaken for p=', () => {
    expect(parseDmarcTags('v=DMARC1; sp=reject; p=none').get('p')).toBe('none');
  });

  it('migrates stored recommendations: legacy pct rows and new testing marker', () => {
    expect(stepIndexFromStored('quarantine', 10)).toBe(2);
    expect(stepIndexFromStored('reject', 50)).toBe(4);
    expect(stepIndexFromStored('quarantine', 0)).toBe(1);
    expect(stepIndexFromStored('reject', 0)).toBe(3);
    expect(stepIndexFromStored('reject', 100)).toBe(4);
    expect(stepIndexFromStored(null, null)).toBe(-1);
  });

  it('round-trips new steps through storage', () => {
    for (const [i, step] of ROLLOUT_SEQUENCE.entries()) {
      if (step.policy === 'none') continue;
      const { policy, pct } = toStored(step);
      expect(stepIndexFromStored(policy, pct)).toBe(i);
    }
  });
});

describe('buildStepRecord', () => {
  it('sets p=, sp=, np= and t=y for a testing step, preserving other tags', () => {
    const rec = buildStepRecord('v=DMARC1; p=none; rua=mailto:foo@example.com; adkim=s', Q_T);
    expect(rec).toBe('v=DMARC1; p=quarantine; sp=quarantine; np=quarantine; t=y; rua=mailto:foo@example.com; adkim=s');
  });

  it('drops pct= and t= when advancing to an enforced step', () => {
    const rec = buildStepRecord('v=DMARC1; p=quarantine; pct=50; t=y; rua=mailto:foo@example.com', Q);
    expect(rec).toBe('v=DMARC1; p=quarantine; sp=quarantine; np=quarantine; rua=mailto:foo@example.com');
    expect(rec).not.toMatch(/pct=|t=/);
  });

  it('migrates a legacy pct record forward without pct', () => {
    const rec = buildStepRecord('v=DMARC1; p=reject; pct=10; rua=mailto:foo@example.com', R);
    expect(rec).toBe('v=DMARC1; p=reject; sp=reject; np=reject; rua=mailto:foo@example.com');
  });

  it('strips outer quotes from CF API response', () => {
    const rec = buildStepRecord('"v=DMARC1; p=quarantine"', R_T);
    expect(rec).not.toMatch(/^"|"$/);
    expect(rec).toContain('p=reject');
    expect(rec).toContain('t=y');
  });

  it('never weakens an existing stricter sp=/np=', () => {
    const rec = buildStepRecord('v=DMARC1; p=none; sp=reject; np=quarantine', Q);
    const tags = parseDmarcTags(rec);
    expect(tags.get('sp')).toBe('reject');
    expect(tags.get('np')).toBe('quarantine');
  });

  it('builds a record from the p=none step (existing effective sp/np are never weakened)', () => {
    expect(buildStepRecord('v=DMARC1; p=none', NONE)).toBe('v=DMARC1; p=none; sp=none; np=none');
    expect(buildStepRecord('v=DMARC1; p=quarantine', NONE)).toBe('v=DMARC1; p=none; sp=quarantine; np=quarantine');
  });
});

describe('detectRollbackRisk', () => {
  it(`flags a drop of >= ${ROLLBACK_THRESHOLD_PP}pp`, () => {
    expect(detectRollbackRisk(79, 90)).toBe(true);
    expect(detectRollbackRisk(80, 90)).toBe(true); // exactly at threshold
  });

  it(`does not flag a drop < ${ROLLBACK_THRESHOLD_PP}pp`, () => {
    expect(detectRollbackRisk(85, 90)).toBe(false);
    expect(detectRollbackRisk(90, 90)).toBe(false);
  });

  it('returns false when either rate is null', () => {
    expect(detectRollbackRisk(null, 90)).toBe(false);
    expect(detectRollbackRisk(80, null)).toBe(false);
    expect(detectRollbackRisk(null, null)).toBe(false);
  });
});

describe('pct=0 (RFC 9989 Appendix A.6: equivalent to t=y)', () => {
  it('maps to the testing step of the same policy', () => {
    expect(stepIndexFor('quarantine', 0)).toBe(1);
    expect(stepIndexFor('reject', 0)).toBe(3);
    expect(stepIndexFor('none', 0)).toBe(0);
    expect(stepIndexForRecord('v=DMARC1; p=quarantine; pct=0')).toBe(1);
    expect(stepIndexForRecord('v=DMARC1; p=reject; pct=0; rua=mailto:a@b.c')).toBe(3);
  });

  it('1-99 still maps to enforced, 100 to enforced', () => {
    expect(stepIndexFor('quarantine', 1)).toBe(2);
    expect(stepIndexFor('reject', 99)).toBe(4);
  });
});

describe('sp=/np= inheritance and t=y (RFC 9989: t applies to p, sp and np)', () => {
  it('an absent np inherits sp: p=none; sp=reject keeps np=reject', () => {
    const tags = parseDmarcTags(buildStepRecord('v=DMARC1; p=none; sp=reject', Q));
    expect(tags.get('sp')).toBe('reject');
    expect(tags.get('np')).toBe('reject');
  });

  it('an absent sp inherits p: p=quarantine, no sp/np, step reject keeps sp=np=reject', () => {
    const tags = parseDmarcTags(buildStepRecord('v=DMARC1; p=quarantine', R));
    expect([tags.get('sp'), tags.get('np')]).toEqual(['reject', 'reject']);
  });

  it('explicit np wins over inherited sp', () => {
    const tags = parseDmarcTags(buildStepRecord('v=DMARC1; p=none; sp=reject; np=none', Q));
    expect(tags.get('sp')).toBe('reject');
    expect(tags.get('np')).toBe('quarantine');
  });

  it('testingWouldWeaken: stricter sp or inherited np under t=y', () => {
    expect(testingWouldWeaken('v=DMARC1; p=none; sp=reject', Q_T)).toBe(true);
    expect(testingWouldWeaken('v=DMARC1; p=none; sp=quarantine', Q_T)).toBe(true);
    expect(testingWouldWeaken('v=DMARC1; p=none; np=reject', Q_T)).toBe(true);
    expect(testingWouldWeaken('v=DMARC1; p=quarantine; sp=reject', R_T)).toBe(true);
  });

  it('testingWouldWeaken: plain forward steps and enforced steps are fine', () => {
    expect(testingWouldWeaken('v=DMARC1; p=none', Q_T)).toBe(false);
    expect(testingWouldWeaken('v=DMARC1; p=quarantine', R_T)).toBe(false);
    expect(testingWouldWeaken('v=DMARC1; p=none; sp=reject', Q)).toBe(false);
  });

  it('buildStepRecord refuses a t=y step that would weaken sp=', () => {
    expect(() => buildStepRecord('v=DMARC1; p=none; sp=reject', Q_T)).toThrow(/weaken/);
    expect(() => buildStepRecord('v=DMARC1; p=quarantine; sp=reject', R_T)).toThrow(/weaken/);
  });
});

describe('planNextStep', () => {
  it('plain advance from p=none goes to quarantine t=y', () => {
    const plan = planNextStep('v=DMARC1; p=none')!;
    expect(plan.step).toEqual(Q_T);
    expect(plan.note).toBeNull();
    expect(plan.skippedTesting).toBe(false);
  });

  it('follows the sequence for new-style records', () => {
    expect(planNextStep('v=DMARC1; p=quarantine; t=y')!.step).toEqual(Q);
    expect(planNextStep('v=DMARC1; p=quarantine')!.step).toEqual(R_T);
    expect(planNextStep('v=DMARC1; p=reject; t=y')!.step).toEqual(R);
    expect(planNextStep('v=DMARC1; p=reject')).toBeNull();
    expect(planNextStep('v=DMARC1; p=bogus')).toBeNull();
  });

  it('skips t=y straight to enforced when it would weaken sp= (p=none; sp=reject)', () => {
    const plan = planNextStep('v=DMARC1; p=none; sp=reject')!;
    expect(plan.step).toEqual(Q);
    expect(plan.skippedTesting).toBe(true);
    expect(plan.note).toMatch(/weaken/);
    // and the resulting record is actually safe to build
    const tags = parseDmarcTags(buildStepRecord('v=DMARC1; p=none; sp=reject', plan.step));
    expect([tags.get('p'), tags.get('sp'), tags.get('np'), tags.has('t')]).toEqual(['quarantine', 'reject', 'reject', false]);
  });

  it('skips t=y one step later (p=quarantine; sp=reject → reject enforced)', () => {
    const plan = planNextStep('v=DMARC1; p=quarantine; sp=reject')!;
    expect(plan.step).toEqual(R);
    expect(plan.skippedTesting).toBe(true);
  });

  it('partial-pct quarantine: next step is quarantine (full), labelled honestly', () => {
    for (const pct of [10, 50]) {
      const plan = planNextStep(`v=DMARC1; p=quarantine; pct=${pct}`)!;
      expect(plan.step).toEqual(Q);
      expect(plan.dropsPartialPct).toBe(true);
      expect(plan.note).toContain(`pct=${pct}`);
      expect(plan.note).toContain('100%');
      expect(buildStepRecord(`v=DMARC1; p=quarantine; pct=${pct}`, plan.step)).not.toMatch(/pct=/);
    }
  });

  it('partial-pct reject offers reject (full) instead of "fully graduated"', () => {
    const plan = planNextStep('v=DMARC1; p=reject; pct=50')!;
    expect(plan.step).toEqual(R);
    expect(plan.dropsPartialPct).toBe(true);
  });

  it('pct=100 / pct=0 are not partial', () => {
    expect(planNextStep('v=DMARC1; p=quarantine; pct=100')!.dropsPartialPct).toBe(false);
    expect(planNextStep('v=DMARC1; p=quarantine; pct=0')!.step).toEqual(Q);
  });
});
