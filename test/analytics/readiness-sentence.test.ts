// Readiness headlines say what actually changes. Moving to a policy the domain is already at is not "moving": it is
// leaving testing mode or taking a partial pct to 100%. Sentences are built from parsed values, never a record fragment.
import { describe, expect, it } from 'vitest';
import { assessReadiness } from '../../src/analytics/readiness';

const input = (record: string | null, passed = 4990) => ({ state: { record }, messages: 5000, passed, daysWithReports: 28, windowDays: 30, fixes: [], newSenders: 0 });
const headline = (record: string, passed?: number) => assessReadiness(input(record, passed)).headline;

describe('readiness headline: ready', () => {
  it.each([
    ['v=DMARC1; p=none', 'Safe to move to quarantine'],
    ['v=DMARC1; t=y; p=none', 'Safe to move to quarantine'],
    ['v=DMARC1; p=quarantine; t=y', 'Safe to turn off testing mode (t=y) for quarantine'],
    ['v=DMARC1; p=quarantine; t=y; sp=none', 'Safe to turn off testing mode (t=y) for quarantine'],
    ['v=DMARC1; p=quarantine', 'Safe to move to reject'],
    ['v=DMARC1; sp=reject; p=quarantine', 'Safe to move to reject'],
    ['v=DMARC1; p=reject; t=y', 'Safe to turn off testing mode (t=y) for reject'],
  ])('%s -> %s', (record, sentence) => {
    expect(headline(record)).toBe(sentence);
  });
});

describe('readiness headline: a partial pct is raised to 100%, with the care its note asks for', () => {
  it('quarantine pct=25', () => expect(headline('v=DMARC1; p=quarantine; pct=25')).toBe('You can raise pct from 25% to 100% for quarantine, with care'));
  it('reject pct=50', () => expect(headline('v=DMARC1; p=reject; pct=50')).toBe('You can raise pct from 50% to 100% for reject, with care'));
});

describe('readiness headline: not safe yet', () => {
  it.each([
    ['v=DMARC1; p=none', 'Not safe to move to quarantine yet'],
    ['v=DMARC1; p=quarantine; t=y', 'Not safe to turn off testing mode (t=y) for quarantine yet'],
    ['v=DMARC1; p=quarantine; pct=25', 'Not safe to raise pct from 25% to 100% for quarantine yet'],
    ['v=DMARC1; p=quarantine', 'Not safe to move to reject yet'],
    ['v=DMARC1; p=reject; t=y', 'Not safe to turn off testing mode (t=y) for reject yet'],
  ])('%s -> %s', (record, sentence) => {
    const r = assessReadiness(input(record, 3000));
    expect(r.status).toBe('blocked');
    expect(r.headline).toBe(sentence);
  });
});

describe('readiness headline: with care', () => {
  it('reject t=y at a 95% pass rate', () => expect(headline('v=DMARC1; p=reject; t=y', 4750)).toBe('You can turn off testing mode (t=y) for reject, with care'));
  it('none at a 95% pass rate', () => expect(headline('v=DMARC1; p=none', 4750)).toBe('You can move to quarantine, with care'));
});

describe('readiness headline: no raw record fragment', () => {
  it('no reason repeats "p=<policy>; t=y"', () => {
    for (const record of ['v=DMARC1; p=quarantine; t=y', 'v=DMARC1; p=reject; t=y', 'v=DMARC1; p=none']) {
      for (const reason of assessReadiness(input(record)).reasons) expect(reason.text).not.toMatch(/p=\w+; t=y/);
    }
  });
});
