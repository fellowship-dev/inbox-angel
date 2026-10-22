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
    messages: 100, first_seen: NOW - 20 * DAY, last_seen: NOW - DAY,
    reverse_dns: null, base_domain: null, org: null, country_code: null, ...o,
  };
}

describe('identifySender', () => {
  it('recognises providers by authenticated domain, reverse DNS, then network owner', () => {
    expect(identifySender({ spf_domain: 'bounce.mcsv.net' })?.name).toBe('Mailchimp');
    expect(identifySender({ reverse_dns: 'o1.em.sendgrid.net' })?.name).toBe('SendGrid');
    expect(identifySender({ org: 'Google LLC' })?.name).toBe('Google Workspace');
    expect(identifySender({ reverse_dns: 'smtp.example.org', org: 'Example Hosting' })).toBeNull();
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

const dom = { id: 1, domain: 'acme.com', spf_record: 'v=spf1 include:_spf.google.com ~all' };
const send = (rows: SenderRow[]) => buildSenders(rows, { now: NOW, earliest: NOW - 60 * DAY });
const mailchimp = (o: Partial<SenderRow> = {}) => row({ source_ip: '198.2.180.1', reverse_dns: 'mail1.mcsv.net', spf_domain: 'mcsv.net', dkim_domain: 'mcsv.net', ...o });

describe('buildFixes', () => {
  it('ranks a failing provider first and names the SPF include and DKIM setup', () => {
    const fixes = buildFixes(dom, send([row({ messages: 880 }), mailchimp({ messages: 120 })]));
    expect(fixes[0]).toMatchObject({ kind: 'authorize-sender', severity: 'high', sender: { name: 'Mailchimp' }, share_pct: 12, affected_pct: 12 });
    expect(fixes[0]!.title).toBe('Mailchimp sends 12% of your mail and fails DMARC');
    expect(fixes[0]!.steps[0]).toContain('include:servers.mcsv.net');
    expect(fixes[0]!.records).toContainEqual({ type: 'TXT', name: 'acme.com', value: 'v=spf1 include:_spf.google.com include:servers.mcsv.net ~all' });
    expect(fixes[0]!.records).toContainEqual({ type: 'CNAME', name: 'k1._domainkey.acme.com', value: 'dkim.mcsv.net' });
    expect(fixes[0]!.guide_url).toContain('mailchimp.com');
  });

  it('says "fails DKIM alignment" for a provider that passes through SPF alone', () => {
    const fixes = buildFixes(dom, send([row({ messages: 880 }), mailchimp({ messages: 120, spf_domain: 'bounce.acme.com' })]));
    expect(fixes[0]).toMatchObject({ kind: 'fix-dkim-alignment', severity: 'medium' });
    expect(fixes[0]!.title).toBe('Mailchimp sends 12% of your mail and fails DKIM alignment');
    expect(fixes[0]!.records).toEqual([{ type: 'CNAME', name: 'k1._domainkey.acme.com', value: 'dkim.mcsv.net' }]);
  });

  it('does not tell you to add an include that is already there, and never invents a record without one', () => {
    const withInclude = { ...dom, spf_record: 'v=spf1 include:servers.mcsv.net ~all' };
    const [fix] = buildFixes(withInclude, send([row({ messages: 880 }), mailchimp({ messages: 120 })]));
    expect(fix!.steps[0]).toContain('already includes servers.mcsv.net');
    expect(fix!.records.every((r) => r.type !== 'TXT')).toBe(true);
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

const base = { policy: 'none', testing: false, messages: 5000, passed: 4990, daysWithReports: 28, windowDays: 30, fixes: [], newSenders: 0 };

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
  it('blocks below the rollout pass-rate threshold, cautions between 90 and 98', () => {
    const low = assessReadiness({ ...base, passed: 4000 });
    expect(low.status).toBe('blocked');
    expect(low.reasons.find((x) => x.level === 'block')!.text).toMatch(/80%.*at least 90%/);
    expect(assessReadiness({ ...base, passed: 4700 }).status).toBe('caution');
  });
  it('a recognised service failing blocks real enforcement but only warns before testing mode', () => {
    const fix = buildFixes(dom, send([row({ messages: 880 }), mailchimp({ messages: 120 })]));
    const early = assessReadiness({ ...base, passed: 4900, fixes: fix });
    expect(early.status).toBe('caution');
    const enforcing = assessReadiness({ ...base, policy: 'quarantine', testing: true, passed: 4900, fixes: fix });
    expect(enforcing.next).toMatchObject({ policy: 'quarantine', testing: false });
    expect(enforcing.status).toBe('blocked');
    expect(enforcing.reasons.some((x) => x.level === 'block' && x.text.includes('Mailchimp'))).toBe(true);
  });
  it('cautions on new senders', () => {
    expect(assessReadiness({ ...base, newSenders: 2 }).status).toBe('caution');
  });
  it('knows the end of the sequence, a missing record and a subdomain that inherits', () => {
    expect(assessReadiness({ ...base, policy: 'reject' }).status).toBe('complete');
    expect(assessReadiness({ ...base, policy: null }).status).toBe('no_policy');
    const sub = assessReadiness({ ...base, policy: null, inherits: true });
    expect(sub.status).toBe('no_policy');
    expect(sub.headline).toMatch(/parent/);
  });
  it('steps on from t=y to the enforcing step', () => {
    expect(assessReadiness({ ...base, policy: 'reject', testing: true }).next).toMatchObject({ policy: 'reject', testing: false });
  });
});
