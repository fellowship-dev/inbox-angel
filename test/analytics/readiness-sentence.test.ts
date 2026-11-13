// Readiness sentences name the policy (none / quarantine / reject), never a fragment of the record ("p=quarantine; t=y").
import { describe, expect, it } from 'vitest';
import { assessReadiness } from '../../src/analytics/readiness';

const input = (record: string | null) => ({ state: { record }, messages: 5000, passed: 4990, daysWithReports: 28, windowDays: 30, fixes: [], newSenders: 0 });
const SENTENCE = /^(Safe to move to|You can move to|Not safe to move to) (none|quarantine|reject)( yet|, with care)?$/;

describe('readiness headline', () => {
  it.each([
    ['v=DMARC1; p=none; t=y'],
    ['v=DMARC1; t=y; p=none'],
    ['v=DMARC1; p=none'],
    ['v=DMARC1; p=quarantine; t=y; sp=none'],
    ['v=DMARC1; sp=reject; p=quarantine'],
  ])('is built from the policy name only: %s', (record) => {
    const r = assessReadiness(input(record));
    expect(r.headline).toMatch(SENTENCE);
    expect(r.headline).not.toMatch(/[;=]/);
    for (const reason of r.reasons) expect(reason.text).not.toMatch(/p=\w+; t=y/);
  });
  it('names the same policy whatever the tag order', () => {
    expect(assessReadiness(input('v=DMARC1; t=y; p=none')).headline).toBe(assessReadiness(input('v=DMARC1; p=none; t=y')).headline);
  });
  it('a blocked domain says so with the name only', () => {
    const r = assessReadiness({ ...input('v=DMARC1; p=none'), passed: 3000 });
    expect(r.status).toBe('blocked');
    expect(r.headline).toBe('Not safe to move to quarantine yet');
  });
});
