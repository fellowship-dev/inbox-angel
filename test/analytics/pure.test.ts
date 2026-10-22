import { describe, it, expect } from 'vitest';
import type { SenderRow } from '@inbox-angel/db';
import { identifySender } from '@inbox-angel/dns-checks/sender-providers';
import { buildSenders, recordAlignment } from '../../src/analytics/senders';
import { buildFixes, spfWithInclude } from '../../src/analytics/fixes';
import { assessReadiness } from '../../src/analytics/readiness';

const NOW = 1_800_000_000;
const DAY = 86400;

function row(o: Partial<SenderRow> = {}): SenderRow {
  return {
    source_ip: '1.1.1.1', domain_id: 1, domain: 'acme.com', header_from: 'acme.com',
    spf_domain: 'acme.com', spf_result: 'pass', dkim_domain: 'acme.com', dkim_result: 'pass',
    messages: 100, advice_messages: 100, first_seen: NOW - 20 * DAY, last_seen: NOW - DAY,
    reverse_dns: null, base_domain: null, org: null, country_code: null, ...o,
  };
}

describe('identifySender', () => {
  it('recognises providers by authenticated domain, reverse DNS, then network owner', () => {
    expect(identifySender({ spf_domain: 'bounce.mcsv.net' })?.name).toBe('Mailchimp');
    expect(identifySender({ reverse_dns: 'o1.em.sendgrid.net' })?.name).toBe('SendGrid');
    expect(identifySender({ reverse_dns: 'mail-sor-f41.google.com' })?.name).toBe('Google Workspace');
    expect(identifySender({ org: 'SendGrid, Inc.' })?.name).toBe('SendGrid');
    expect(identifySender({ reverse_dns: 'smtp.example.org', org: 'Example Hosting' })).toBeNull();
  });
  it('never labels a general cloud network as Workspace or Microsoft 365', () => {
    for (const org of ['Google LLC', 'Google Cloud', 'Microsoft Corporation', 'Microsoft Azure']) expect(identifySender({ org })).toBeNull();
    expect(identifySender({ reverse_dns: '34.1.2.3.bc.googleusercontent.com', org: 'Google LLC' })).toBeNull();
    expect(identifySender({ reverse_dns: 'vm1.cloudapp.azure.com', org: 'Microsoft Corporation' })).toBeNull();
  });
  it('ships no DKIM record values: they are per account', () => {
    expect(identifySender({ reverse_dns: 'a.mcsv.net' })).not.toHaveProperty('dkimCname');
  });
  it('matches whole labels, not substrings', () => {
    expect(identifySender({ reverse_dns: 'notgoogle.com' })).toBeNull();
    expect(identifySender({ reverse_dns: 'evilsendgrid.net.attacker.test' })).toBeNull();
  });
  it('ties a provider to the registry include used by the SPF checks', () => {
    expect(identifySender({ reverse_dns: 'a.mcsv.net' })?.registry?.include).toBe('servers.mcsv.net');
  });
});

describe('recordAlignment', () => {
  it('needs a pass AND a domain under the From organizational domain', () => {
    expect(recordAlignment(row())).toEqual({ spf: true, dkim: true });
    expect(recordAlignment(row({ spf_domain: 'em.acme.com', dkim_domain: 'mcsv.net' }))).toEqual({ spf: true, dkim: false });
    expect(recordAlignment(row({ spf_result: 'fail', dkim_result: 'none' }))).toEqual({ spf: false, dkim: false });
  });
  it('falls back to the domain when header_from is missing', () => {
    expect(recordAlignment(row({ header_from: null })).spf).toBe(true);
  });
});

describe('buildSenders', () => {
  it('rolls rows up per IP with rates, share and a provider', () => {
    const senders = buildSenders([
      row({ source_ip: '9.9.9.9', messages: 90, reverse_dns: 'a.google.com' }),
      row({ source_ip: '9.9.9.9', messages: 10, spf_result: 'fail', dkim_result: 'fail' }),
      row({ source_ip: '8.8.8.8', messages: 100, spf_domain: 'mcsv.net', dkim_domain: 'mcsv.net' }),
    ], { now: NOW, earliest: NOW - 60 * DAY });
    const g = senders.find((s) => s.source_ip === '9.9.9.9')!;
    expect(g).toMatchObject({ messages: 100, share_pct: 50, spf_aligned_pct: 90, dkim_aligned_pct: 90, dmarc_pass_pct: 90, dmarc_fail_messages: 10 });
    expect(g.provider?.name).toBe('Google Workspace');
    expect(senders.find((s) => s.source_ip === '8.8.8.8')).toMatchObject({ dmarc_pass_pct: 0, spf_domain: 'mcsv.net' });
  });

  it('flags a sender as new only when older history exists to compare with', () => {
    const fresh = row({ source_ip: '5.5.5.5', first_seen: NOW - 2 * DAY });
    expect(buildSenders([fresh], { now: NOW, earliest: NOW - 40 * DAY })[0]!.is_new).toBe(true);
    expect(buildSenders([fresh], { now: NOW, earliest: NOW - 2 * DAY })[0]!.is_new).toBe(false);
    expect(buildSenders([row({ first_seen: NOW - 30 * DAY })], { now: NOW, earliest: NOW - 40 * DAY })[0]!.is_new).toBe(false);
  });

  it('merges one IP across domains and lists them', () => {
    const [s] = buildSenders([row({ domain: 'a.com', header_from: 'a.com', spf_domain: 'a.com', dkim_domain: 'a.com' }), row({ domain: 'b.com', domain_id: 2, header_from: 'b.com', spf_domain: 'b.com', dkim_domain: 'b.com' })], { now: NOW, earliest: null });
    expect(s!.domains).toEqual(['a.com', 'b.com']);
    expect(s!.messages).toBe(200);
  });
});

import { ROLLOUT_SEQUENCE, planNextStep, stepIndexForRecord, stepIndexFromStored } from '../../src/dmarc/rollout';
import { recordFromStored, resolveStep } from '../../src/analytics/readiness';
import { aligned } from '../../src/analytics/senders';

describe('strict alignment', () => {
  it('needs the same domain, not just the same organization', () => {
    expect(aligned('em.acme.com', 'acme.com', 'r')).toBe(true);
    expect(aligned('em.acme.com', 'acme.com', 's')).toBe(false);
    expect(aligned('ACME.com.', 'acme.com', 's')).toBe(true);
  });
  it('changes the derived rates when the record says adkim=s / aspf=s', () => {
    const r = [row({ spf_domain: 'em.acme.com', dkim_domain: 'em.acme.com' })];
    expect(buildSenders(r, { now: NOW, earliest: null })[0]).toMatchObject({ spf_aligned_pct: 100, dkim_aligned_pct: 100 });
    expect(buildSenders(r, { now: NOW, earliest: null, align: { spf: 's', dkim: 'r' } })[0]).toMatchObject({ spf_aligned_pct: 0, dkim_aligned_pct: 100 });
  });
});

const dom = { id: 1, domain: 'acme.com', spf_record: 'v=spf1 include:_spf.google.com ~all' };
const send = (rows: SenderRow[]) => buildSenders(rows, { now: NOW, earliest: NOW - 60 * DAY });
/** Mailchimp with its own envelope domain (mcsv.net): SPF can never align, only DKIM can. */
const mailchimp = (o: Partial<SenderRow> = {}) => row({ source_ip: '198.2.180.1', reverse_dns: 'mail1.mcsv.net', spf_domain: 'mcsv.net', dkim_domain: 'mcsv.net', ...o });
/** The same provider sending with a return-path on the customer's domain: SPF could align if it were authorized. */
const ownEnvelope = (o: Partial<SenderRow> = {}) => mailchimp({ spf_domain: 'bounce.acme.com', spf_result: 'fail', ...o });

describe('buildFixes', () => {
  it('ranks a failing provider first and, when SPF can align, names the include with a ready record', () => {
    const fixes = buildFixes({ ...dom, spf_lookup_count: 3 }, send([row({ messages: 880 }), ownEnvelope({ messages: 120 })]));
    expect(fixes[0]).toMatchObject({ kind: 'authorize-sender', severity: 'high', sender: { name: 'Mailchimp' }, share_pct: 12, affected_pct: 12 });
    expect(fixes[0]!.title).toBe('Mailchimp sends 12% of your mail and fails DMARC');
    expect(fixes[0]!.detail).toMatch(/^Estimated from the reports/);
    expect(fixes[0]!.steps[0]).toContain('include:servers.mcsv.net');
    expect(fixes[0]!.records).toEqual([{ type: 'TXT', name: 'acme.com', value: 'v=spf1 include:_spf.google.com include:servers.mcsv.net ~all' }]);
    expect(fixes[0]!.guide_url).toContain('mailchimp.com');
  });

  it('recommends DKIM only when the sender uses its own envelope domain (SPF cannot align)', () => {
    const [fix] = buildFixes({ ...dom, spf_lookup_count: 3 }, send([row({ messages: 880 }), mailchimp({ messages: 120 })]));
    expect(fix!.kind).toBe('authorize-sender');
    expect(fix!.steps.join(' ')).toMatch(/SPF cannot align for Mailchimp: it sends with its own envelope domain \(mcsv\.net\)/);
    expect(fix!.steps.join(' ')).not.toContain('Add include:');
    expect(fix!.records).toEqual([]);
    expect(fix!.steps.join(' ')).toMatch(/DKIM/);
  });

  it('never publishes a static DKIM record for any provider', () => {
    const fixes = buildFixes(dom, send([row({ messages: 880 }), mailchimp({ messages: 120 }), ownEnvelope({ source_ip: '1.2.3.4', messages: 50 })]));
    expect(fixes.flatMap((f) => f.records).every((r) => r.type !== 'CNAME')).toBe(true);
  });

  it('refuses to add an include that would push SPF past 10 lookups, and says to flatten', () => {
    const rows = [row({ messages: 880 }), ownEnvelope({ messages: 120 })];
    const over = buildFixes({ ...dom, spf_lookup_count: 9 }, send(rows))[0]!;
    expect(over.records).toEqual([]);
    expect(over.steps[0]).toMatch(/Do not add include:servers\.mcsv\.net yet.*9 of the 10.*Flatten/);
    const near = buildFixes({ ...dom, spf_lookup_count: 7 }, send(rows))[0]!;
    expect(near.steps.join(' ')).toMatch(/about 8 of the 10/);
    expect(near.records).toHaveLength(1);
    const unknown = buildFixes({ ...dom, spf_lookup_count: null }, send(rows))[0]!;
    expect(unknown.steps.join(' ')).toMatch(/do not know how many DNS lookups/);
    expect(unknown.records).toHaveLength(1);
  });

  it('says "fails DKIM alignment" for a provider that passes through SPF alone, with no invented record', () => {
    const fixes = buildFixes(dom, send([row({ messages: 880 }), mailchimp({ messages: 120, spf_domain: 'bounce.acme.com', spf_result: 'pass' })]));
    expect(fixes[0]).toMatchObject({ kind: 'fix-dkim-alignment', severity: 'medium', records: [] });
    expect(fixes[0]!.title).toBe('Mailchimp sends 12% of your mail and fails DKIM alignment');
  });

  it('does not tell you to add an include that is already there, and never invents a record without one', () => {
    const withInclude = { ...dom, spf_record: 'v=spf1 include:servers.mcsv.net ~all' };
    const [fix] = buildFixes(withInclude, send([row({ messages: 880 }), ownEnvelope({ messages: 120 })]));
    expect(fix!.steps[0]).toContain('already includes servers.mcsv.net');
    expect(fix!.records).toEqual([]);
    expect(spfWithInclude('v=spf1 redirect=_spf.x.com', 'a.com')).toBeNull();
    expect(spfWithInclude(null, 'a.com')).toBeNull();
  });

  it('asks you to investigate an unrecognised failing sender instead of guessing a provider', () => {
    const fixes = buildFixes(dom, send([row({ messages: 900 }), row({ source_ip: '203.0.113.9', messages: 100, spf_result: 'fail', dkim_result: 'none', org: 'Shady Hosting' })]));
    expect(fixes[0]).toMatchObject({ kind: 'investigate-sender', sender: { provider_id: null }, records: [] });
    expect(fixes[0]!.title).toContain('Shady Hosting');
  });

  it('ignores noise and healthy senders; lists a new passing sender as low priority', () => {
    expect(buildFixes(dom, send([row({ messages: 5000 }), mailchimp({ messages: 3 })]))).toEqual([]);
    const fixes = buildFixes(dom, send([row({ messages: 900 }), row({ source_ip: '167.89.1.1', reverse_dns: 'o1.sendgrid.net', messages: 100, first_seen: NOW - DAY })]));
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ kind: 'review-new-sender', severity: 'low', title: 'New sender: SendGrid' });
  });

  it('is empty with no mail', () => expect(buildFixes(dom, [])).toEqual([]));
});

const stored = (policy: string | null, pct: number | null = null) => ({ policy, pct });
const base = { state: stored('none'), messages: 5000, passed: 4990, daysWithReports: 28, windowDays: 30, fixes: [], newSenders: 0 };

describe('assessReadiness', () => {
  it('is ready for the next step on clean data, and names the step', () => {
    const r = assessReadiness(base);
    expect(r.status).toBe('ready');
    expect(r.next).toMatchObject({ policy: 'quarantine', testing: true, label: 'p=quarantine; t=y' });
    expect(r.headline).toBe('Safe to move to p=quarantine; t=y');
    expect(r.reasons.every((x) => x.level === 'ok')).toBe(true);
  });
  it('needs enough data before judging', () => {
    expect(assessReadiness({ ...base, messages: 40, passed: 40 }).status).toBe('insufficient_data');
    expect(assessReadiness({ ...base, daysWithReports: 3 }).status).toBe('insufficient_data');
  });
  it('blocks below the rollout pass-rate threshold (the reports\' own totals), cautions between 90 and 98', () => {
    const low = assessReadiness({ ...base, passed: 4000 });
    expect(low.status).toBe('blocked');
    expect(low.reasons.find((x) => x.level === 'block')!.text).toMatch(/80%.*at least 90%/);
    expect(assessReadiness({ ...base, passed: 4700 }).status).toBe('caution');
  });
  it('estimated per-sender failures only ever warn, even before a real enforcement step', () => {
    const fix = buildFixes(dom, send([row({ messages: 880 }), ownEnvelope({ messages: 120 })]));
    expect(fix[0]!.kind).toBe('authorize-sender');
    const early = assessReadiness({ ...base, passed: 4900, fixes: fix });
    expect(early.status).toBe('caution');
    const enforcing = assessReadiness({ ...base, state: stored('quarantine', 0), passed: 4900, fixes: fix });
    expect(enforcing.next).toMatchObject({ policy: 'quarantine', testing: false });
    expect(enforcing.status).toBe('caution');
    expect(enforcing.reasons.some((x) => x.level === 'block')).toBe(false);
    expect(enforcing.reasons.some((x) => x.level === 'warn' && x.text.includes('Mailchimp') && x.text.includes('estimated'))).toBe(true);
  });
  it('cautions on new senders', () => {
    expect(assessReadiness({ ...base, newSenders: 2 }).status).toBe('caution');
  });
  it('knows the end of the sequence, a missing record and a subdomain that inherits', () => {
    expect(assessReadiness({ ...base, state: stored('reject', 100) }).status).toBe('complete');
    expect(assessReadiness({ ...base, state: stored(null) }).status).toBe('no_policy');
    expect(assessReadiness({ ...base, state: { record: null } }).status).toBe('no_policy');
    const sub = assessReadiness({ ...base, state: { record: null }, inherits: true });
    expect(sub.status).toBe('no_policy');
    expect(sub.headline).toMatch(/parent/);
  });
  it('steps on from t=y to the enforcing step', () => {
    expect(assessReadiness({ ...base, state: stored('reject', 0) }).next).toMatchObject({ policy: 'reject', testing: false });
  });
  it('legacy partial pct: the next step is the same policy fully enforced, with a warning that pct is dropped', () => {
    const r = assessReadiness({ ...base, state: stored('quarantine', 50) });
    expect(r.next).toMatchObject({ policy: 'quarantine', testing: false });
    expect(r.status).toBe('caution');
    expect(r.reasons.some((x) => x.level === 'warn' && /pct=50/.test(x.text))).toBe(true);
  });
  it('skips the t=y step when a stricter sp= is published, and says so', () => {
    const r = assessReadiness({ ...base, state: { record: 'v=DMARC1; p=none; sp=reject' } });
    expect(r.next).toMatchObject({ policy: 'quarantine', testing: false });
    expect(r.reasons.some((x) => /Skipping the t=y step/.test(x.text))).toBe(true);
  });
});

// Parity with src/dmarc/rollout.ts: the step readiness reports must be the step rollout-next would offer for the same state.
const expectedNext = (record: string | null) => {
  const idx = record === null ? 0 : stepIndexForRecord(record);
  const plan = record === null ? planNextStep(null) : idx === -1 ? null : planNextStep(record);
  return { idx, step: plan?.step ?? null };
};

describe('readiness follows rollout.ts for every stored state', () => {
  const STATES: Array<[string, number | null]> = [];
  for (const p of ['none', 'quarantine', 'reject']) for (const pct of [null, 0, 10, 50, 100]) STATES.push([p, pct]);

  it.each(STATES)('stored p=%s pct=%s', (policy, pct) => {
    const record = recordFromStored(policy, pct)!;
    const want = expectedNext(record);
    const r = assessReadiness({ ...base, state: stored(policy, pct) });
    expect(r.next ? { policy: r.next.policy, testing: r.next.testing } : null).toEqual(want.step);
    expect(r.current.step).toBe(want.idx);
    // The stored form agrees with the stored-state helper rollout.ts itself ships, where it defines one (pct known).
    if (pct !== null) expect(resolveStep(stored(policy, pct)).index).toBe(stepIndexFromStored(policy, pct));
  });

  it('pct 0 is testing mode: quarantine;t=y offers full quarantine, not reject;t=y', () => {
    const r = assessReadiness({ ...base, state: stored('quarantine', 0) });
    expect(r.current).toMatchObject({ policy: 'quarantine', testing: true, label: 'p=quarantine; t=y' });
    expect(r.next).toMatchObject({ policy: 'quarantine', testing: false });
  });

  const LIVE = [
    'v=DMARC1; p=none; rua=mailto:r@x.io',
    'v=DMARC1; p=none; sp=reject',
    'v=DMARC1; p=none; sp=quarantine; np=reject',
    'v=DMARC1; p=quarantine; t=y',
    'v=DMARC1; p=quarantine; t=y; sp=reject',
    'v=DMARC1; p=quarantine; pct=25',
    'v=DMARC1; p=quarantine; pct=0',
    'v=DMARC1; p=reject; pct=10',
    'v=DMARC1; p=reject; t=y',
    'v=DMARC1; p=reject',
    'v=DMARC1; p=banana',
  ];
  it.each(LIVE)('live record %s', (record) => {
    const want = expectedNext(record);
    const r = assessReadiness({ ...base, state: { record } });
    expect(r.current.step).toBe(Math.max(want.idx, 0));
    expect(r.next ? { policy: r.next.policy, testing: r.next.testing } : null).toEqual(want.step);
  });

  it('covers the whole sequence', () => expect(ROLLOUT_SEQUENCE).toHaveLength(5));
});
