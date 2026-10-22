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
    const rec = buildStepRecord('v=DMARC1; p=none; sp=reject; np=quarantine', Q_T);
    const tags = parseDmarcTags(rec);
    expect(tags.get('sp')).toBe('reject');
    expect(tags.get('np')).toBe('quarantine');
  });

  it('builds a record from the p=none step', () => {
    expect(buildStepRecord('v=DMARC1; p=quarantine', NONE)).toBe('v=DMARC1; p=none; sp=none; np=none');
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
