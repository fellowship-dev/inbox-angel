// Formats free-check results into plain English for founders.
// No jargon above the fold. SPF/DKIM/DMARC acronyms appear only in the detail section.

import { AuthResultsHeader } from './parse-headers';
import { DnsCheckResult } from './dns-check';
import { retentionPolicy } from '../lifecycle/config';

export type OverallStatus = 'protected' | 'at_risk' | 'exposed';

export interface CheckSummary {
  status: OverallStatus;
  domain: string;
  spfPass: boolean;
  dkimPass: boolean;
  dmarcPass: boolean;
  dmarcPolicy: string | null;
  dkimPresent: boolean;
  /** DNS lookups that FAILED (as opposed to finding nothing); results for these are "unknown" */
  spfLookupFailed?: boolean;
  dmarcLookupFailed?: boolean;
  dkimLookupFailed?: boolean;
  /** Records exist but are broken (e.g. two v=spf1 records) */
  spfProblem?: string;
  dmarcProblem?: string;
}

export function buildSummary(
  domain: string,
  auth: AuthResultsHeader | null,
  dns: DnsCheckResult,
): CheckSummary {
  const spfPass  = auth?.spf?.result === 'pass';
  const dkimPass = auth?.dkim?.result === 'pass';
  const dmarcPass = auth?.dmarc?.result === 'pass';
  const dkimPresent = dns.dkim?.present ?? false;
  const dmarcPolicy = dns.dmarc?.policy ?? auth?.dmarc?.policy ?? null;

  let status: OverallStatus;
  if (dmarcPass && (spfPass || dkimPass)) {
    status = 'protected';
  } else if (dmarcPolicy === 'none' || !dmarcPolicy) {
    status = 'exposed';    // no enforcement at all
  } else {
    status = 'at_risk';    // DMARC exists but this email still failed
  }

  return {
    status, domain, spfPass, dkimPass, dmarcPass, dkimPresent, dmarcPolicy,
    ...(dns.problems?.spf ? { spfProblem: dns.problems.spf } : {}),
    ...(dns.problems?.dmarc ? { dmarcProblem: dns.problems.dmarc } : {}),
    ...(dns.errors?.spf ? { spfLookupFailed: true } : {}),
    ...(dns.errors?.dmarc ? { dmarcLookupFailed: true } : {}),
    ...(dns.errors?.dkim ? { dkimLookupFailed: true } : {}),
  };
}

// ── Plain text email report ───────────────────────────────────

const STATUS_LINE: Readonly<Record<OverallStatus, string>> = {
  protected: '✅ Your domain is protected — this email passed all security checks.',
  at_risk:   '⚠️  Your domain has partial protection — but gaps exist that scammers can exploit.',
  exposed:   '🚨 Your domain is not protected — anyone can send emails pretending to be you.',
};

const STATUS_HEADING: Readonly<Record<OverallStatus, string>> = {
  protected: 'Good news',
  at_risk:   'You have some protection, but not full coverage',
  exposed:   'Your domain is wide open to impersonation',
};

function spfLine(s: CheckSummary): string {
  if (s.spfPass) return '✅ SPF — Your email server is verified as an authorized sender.';
  if (s.spfProblem) return `❌ SPF — Your SPF record is broken: ${s.spfProblem}. Receivers will treat it as an error.`;
  if (s.spfLookupFailed) return '⚠️  SPF — We could not look up your SPF record right now (temporary DNS problem).';
  return '❌ SPF — No record found, or this email came from an unauthorized server.';
}

function dkimLine(s: CheckSummary): string {
  if (s.dkimPass) return '✅ DKIM — Your email has a valid digital signature.';
  if (s.dkimPresent) return '❌ DKIM — A signing key exists but this email was not signed.';
  if (s.dkimLookupFailed) return '⚠️  DKIM — We could not look up your signing key right now (temporary DNS problem).';
  return '❌ DKIM — No signing key configured for your domain.';
}

function dmarcLine(s: CheckSummary): string {
  if (s.dmarcPass) {
    const policy = s.dmarcPolicy ?? 'none';
    const enforcement = policy === 'reject'
      ? 'Fake emails are rejected outright.'
      : policy === 'quarantine'
      ? 'Fake emails are sent to spam.'
      : 'No enforcement yet — fake emails still reach inboxes.';
    return `✅ DMARC — Policy is set to "${policy}". ${enforcement}`;
  }
  if (s.dmarcPolicy) {
    return `⚠️  DMARC — Policy "${s.dmarcPolicy}" exists but this email failed the check.`;
  }
  if (s.dmarcProblem) return `❌ DMARC — Your DMARC record is broken: ${s.dmarcProblem}.`;
  if (s.dmarcLookupFailed) return '⚠️  DMARC — We could not look up your DMARC record right now (temporary DNS problem).';
  return '❌ DMARC — No policy set. Nothing stops scammers from impersonating your domain.';
}

// ── Closing (shared with the HTML version) ────────────────────

/** The last line of every free-check email. */
export const HELP_LINE = 'Need help? Any doubts? Reply.';

export interface CheckReportOptions {
  /** The marketing site (SITE_URL), https only. No marketing link when null or unset. */
  siteUrl?: string | null;
  /** How long check results are kept (the lifecycle setting that purges check_results). Defaults to that setting's default. */
  retentionDays?: number;
  /** Set when the sender was enrolled in the follow-up emails: the disclosure line and its unsubscribe link. */
  enrolled?: { text: string; unsubscribeUrl: string };
  /** BOOKING_URL: where "or we do it for you" points first. */
  bookingUrl?: string | null;
  /** Set when the sender is not enrolled but already known: a finished/stopped lead, or a suppressed address. */
  lead?: 'inactive' | 'suppressed';
}

/**
 * What we keep about the sender, truthfully, for each enrolment outcome: check results go after `retentionDays`
 * (check_results); an enrolled address stays until unsubscribe, then only on the suppression list (unsubscribeEmail);
 * a lead no longer in the sequence stays up to 12 months after its last activity (src/funnel/cron.ts); a suppressed
 * address stays suppressed.
 */
export function retentionSentence(o: Pick<CheckReportOptions, 'retentionDays' | 'enrolled' | 'lead'>): string {
  const days = o.retentionDays ?? retentionPolicy({}).checkResultsDays;
  if (o.enrolled) return `We delete this result after ${days} days. We use your address for our follow-up emails until you unsubscribe; after that we keep it only on a do-not-contact list.`;
  if (o.lead === 'inactive') return 'We keep your address and a summary of this result for up to 12 months after your last check, then delete them.';
  if (o.lead === 'suppressed') return `Your address is on our do-not-contact list and stays there, so you get no follow-up emails. We delete this result after ${days} days.`;
  return `We keep your address and this result for ${days} days, then delete them.`;
}

// ── Actionable findings (shared with the HTML version) ────────

/** One fix: what to do, optionally the exact DNS record to publish, and a short note. */
export interface FixStep {
  text: string;
  record?: { name: string; type: 'TXT'; value: string };
  note?: string;
}

/**
 * The exact next record or setting for each failing check, where it is knowable from this email and the live DNS.
 * Record templates only, no inference: SPF never names an include (only the provider knows its own).
 */
export function fixSteps(s: CheckSummary, auth: AuthResultsHeader | null, dns: DnsCheckResult): FixStep[] {
  const d = s.domain;
  const steps: FixStep[] = [];
  if (s.spfLookupFailed || s.dmarcLookupFailed || s.dkimLookupFailed) {
    steps.push({ text: 'Some DNS lookups failed, so parts of this report are incomplete. Send another email in a few minutes to re-run the check.' });
  }

  if (s.spfProblem) {
    steps.push({ text: 'Fix your SPF record: publish exactly one v=spf1 record and keep it within 10 DNS lookups.' });
  } else if (!s.spfPass && !s.spfLookupFailed) {
    const envelope = auth?.spf?.domain ?? d;
    if (!dns.spf) {
      steps.push({ text: `Add an SPF record: one TXT record at ${d} starting with v=spf1 that lists each service that sends your email, exactly as that provider documents it, ending in ~all or -all.` });
    } else {
      steps.push({ text: `SPF failed for ${envelope}: the server that sent this email is not in its SPF record. Add your email provider to the SPF record at ${envelope}, using the include or IP address the provider documents.` });
    }
  }

  if (!s.dkimPass && !s.dkimLookupFailed) {
    const sig = auth?.dkim;
    if (sig?.domain && sig.selector) {
      const align = sig.domain !== d ? ` It also has to be signed with ${d} (or a subdomain) to count for DMARC: turn on DKIM for ${d} in your provider.` : '';
      steps.push({ text: `DKIM failed: this email was signed by d=${sig.domain} with selector s=${sig.selector} (${sig.result}). Check that the TXT record at ${sig.selector}._domainkey.${sig.domain} is the key your email provider shows.${align}` });
    } else if (s.dkimPresent) {
      steps.push({ text: 'Turn on DKIM signing in your email provider: a key is published but this email was not signed.' });
    } else {
      steps.push({ text: 'Enable DKIM signing in your email provider\'s settings and publish the key record it gives you.' });
    }
  }

  if (!s.dmarcPolicy && s.dmarcLookupFailed) { /* unknown: don't tell them to add a record that may exist */ }
  else if (!s.dmarcPolicy) {
    steps.push({
      text: s.dmarcProblem ? `Fix your DMARC record (${s.dmarcProblem}): replace it with this one TXT record.` : 'Add a DMARC record: publish this TXT record.',
      record: { name: `_dmarc.${d}`, type: 'TXT', value: `v=DMARC1; p=none; rua=mailto:dmarc@${d}` },
      note: `Reports go to dmarc@${d}: use a mailbox you read (create it, or put your own address there).`,
    });
  } else if (s.dmarcPolicy === 'none') {
    steps.push({ text: `Change the policy at _dmarc.${d} from p=none to p=quarantine once your own email passes SPF or DKIM; later, p=reject.` });
  } else if (s.dmarcPolicy === 'quarantine') {
    steps.push({ text: `Change the policy at _dmarc.${d} from p=quarantine to p=reject once your own email passes SPF or DKIM.` });
  }
  return steps;
}

/** Where "or we do it for you" points: BOOKING_URL, else SITE_URL/pricing, else nowhere (plain text). */
export function doItForYouUrl(o: Pick<CheckReportOptions, 'bookingUrl' | 'siteUrl'>): string | null {
  return o.bookingUrl || (o.siteUrl ? `${o.siteUrl}/pricing` : null);
}

export const DO_IT_FOR_YOU = 'Or we do it for you';

function whatToDoSection(steps: FixStep[], opts: CheckReportOptions): string {
  if (steps.length === 0) return '';
  const lines = ['', 'What to do next:'];
  steps.forEach((st, i) => {
    lines.push(`${i + 1}. ${st.text}`);
    if (st.record) lines.push(`     ${st.record.name}  ${st.record.type}  "${st.record.value}"`);
    if (st.note) lines.push(`   ${st.note}`);
  });
  const url = doItForYouUrl(opts);
  lines.push('', url ? `${DO_IT_FOR_YOU}: ${url}` : `${DO_IT_FOR_YOU}: reply to this email.`);
  return lines.join('\n');
}

/**
 * Builds the plain text email body sent back to the user after a free check.
 */
export function formatCheckReport(
  fromEmail: string,
  summary: CheckSummary,
  auth: AuthResultsHeader | null,
  dns: DnsCheckResult,
  opts: CheckReportOptions = {},
): string {
  const domain = summary.domain;
  const lines: string[] = [
    `InboxAngel Security Check — ${domain}`,
    '─'.repeat(48),
    '',
    STATUS_LINE[summary.status],
    '',
    STATUS_HEADING[summary.status],
    '─'.repeat(48),
    '',
    'Here is what we found when your email arrived at our server:',
    '',
    spfLine(summary),
    dkimLine(summary),
    dmarcLine(summary),
  ];

  // Raw DNS section (detail, below the fold)
  lines.push('', '── What your DNS looks like right now ──', '');
  if (dns.spf) {
    lines.push(`SPF record:   ${dns.spf.raw}`);
    lines.push(`              Enforcement: ${dns.spf.verdict}`);
  } else {
    lines.push(dns.errors?.spf ? 'SPF record:   (could not be checked — DNS lookup failed)' : 'SPF record:   (none found)');
  }
  if (dns.dmarc) {
    lines.push(`DMARC record: ${dns.dmarc.raw}`);
  } else {
    lines.push(dns.errors?.dmarc ? 'DMARC record: (could not be checked — DNS lookup failed)' : 'DMARC record: (none found)');
  }
  if (dns.dkim) {
    lines.push(`DKIM key:     found (selector used: ${auth?.dkim?.selector ?? 'unknown'})`);
  } else if (dns.errors?.dkim) {
    lines.push('DKIM key:     (could not be checked — DNS lookup failed)');
  } else if (auth?.dkim?.selector) {
    lines.push(`DKIM key:     not found at selector "${auth.dkim.selector}"`);
  } else {
    lines.push('DKIM key:     (no selector in this email — could not verify)');
  }

  const todo = whatToDoSection(fixSteps(summary, auth, dns), opts);
  if (todo) lines.push(todo);
  if (opts.enrolled) lines.push('', opts.enrolled.text, `Unsubscribe: ${opts.enrolled.unsubscribeUrl}`);
  lines.push('');
  lines.push('─'.repeat(48));
  lines.push('This report was generated automatically by InboxAngel.');
  lines.push('You received it because you sent an email to our check address.');
  lines.push(retentionSentence(opts));
  if (opts.siteUrl) lines.push(opts.siteUrl);
  lines.push('', HELP_LINE);

  return lines.join('\n');
}
