// Formats free-check results into plain English for founders.
// No jargon above the fold. SPF/DKIM/DMARC acronyms appear only in the detail section.

import { AuthResultsHeader } from './parse-headers';
import { DnsCheckResult } from './dns-check';

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
    ...(dns.errors?.spf ? { spfLookupFailed: true } : {}),
    ...(dns.errors?.dmarc ? { dmarcLookupFailed: true } : {}),
    ...(dns.errors?.dkim ? { dkimLookupFailed: true } : {}),
  };
}

// ── Plain text email report ───────────────────────────────────

const STATUS_LINE: Record<OverallStatus, string> = {
  protected: '✅ Your domain is protected — this email passed all security checks.',
  at_risk:   '⚠️  Your domain has partial protection — but gaps exist that scammers can exploit.',
  exposed:   '🚨 Your domain is not protected — anyone can send emails pretending to be you.',
};

const STATUS_HEADING: Record<OverallStatus, string> = {
  protected: 'Good news',
  at_risk:   'You have some protection, but not full coverage',
  exposed:   'Your domain is wide open to impersonation',
};

function spfLine(s: CheckSummary): string {
  if (s.spfPass) return '✅ SPF — Your email server is verified as an authorized sender.';
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
  if (s.dmarcLookupFailed) return '⚠️  DMARC — We could not look up your DMARC record right now (temporary DNS problem).';
  return '❌ DMARC — No policy set. Nothing stops scammers from impersonating your domain.';
}

function whatToDoSection(s: CheckSummary): string {
  if (s.status === 'protected') {
    if (s.dmarcPolicy === 'none') {
      return `
What to do next:
Your domain passes authentication, but your DMARC policy is still set to "none" — meaning
fake emails aren't blocked yet. Consider upgrading to p=quarantine or p=reject to fully
protect your customers and vendors.`;
    }
    return `
What to do next:
Nothing urgent. Keep your DNS records as-is and monitor your DMARC reports regularly.`;
  }

  const steps: string[] = [];
  if (s.spfLookupFailed || s.dmarcLookupFailed || s.dkimLookupFailed) {
    steps.push('0. Some DNS lookups failed, so parts of this report are incomplete. Send another email in a few minutes to re-run the check.');
  }
  if (!s.spfPass && !s.spfLookupFailed) steps.push('1. Add an SPF record to your DNS (takes 5 minutes with your domain registrar).');
  if (!s.dkimPass && !s.dkimLookupFailed) steps.push(`${steps.length + 1}. Enable DKIM signing in your email provider's settings.`);
  if (!s.dmarcPolicy && s.dmarcLookupFailed) { /* unknown – don't tell them to add a record that may exist */ }
  else if (!s.dmarcPolicy) steps.push(`${steps.length + 1}. Add a DMARC record starting with p=none to begin monitoring.`);
  else if (s.dmarcPolicy === 'none') steps.push(`${steps.length + 1}. Upgrade your DMARC policy from p=none to p=quarantine, then p=reject.`);

  return `
What to do next:
${steps.join('\n')}

InboxAngel can walk you through each fix and monitor your domain 24/7 so you know the
moment anything breaks. Start your free monitoring at https://inboxangel.com`;
}

/**
 * Builds the plain text email body sent back to the user after a free check.
 */
export function formatCheckReport(
  fromEmail: string,
  summary: CheckSummary,
  auth: AuthResultsHeader | null,
  dns: DnsCheckResult,
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

  lines.push(whatToDoSection(summary));
  lines.push('');
  lines.push('─'.repeat(48));
  lines.push('This report was generated automatically by InboxAngel.');
  lines.push('You received it because you sent an email to our check address.');
  lines.push('No data about your domain is stored. https://inboxangel.com');

  return lines.join('\n');
}
