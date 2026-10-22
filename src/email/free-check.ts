// Free email security check handler.
// Triggered when an email arrives at check-{token}@reports.inboxangel.io.
// The token ties the inbound email to a browser session for front-end polling.
// Parses auth headers, does live DNS lookup, replies with plain-English report, stores result in D1.

import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext/browser';
import type { BoundEnv as Env } from '../index';
import { extractAuthResults } from './parse-headers';
import { checkDomain } from './dns-check';
import { buildSummary, formatCheckReport } from './report-formatter';
import { buildFreeCheckHtml } from './html-templates';
import { globals } from '../db/scope';
import { fromEmail as derivedFromEmail } from '../env-utils';

function extractDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}

/** Raw RFC 5322 reply (multipart text+html). In-Reply-To/References thread it under the original. */
export function buildReplyRaw(
  from: { name: string; addr: string },
  to: string,
  subject: string,
  text: string,
  html: string,
  inReplyTo?: string | null,
): string {
  const msg = createMimeMessage();
  msg.setSender(from);
  msg.setRecipient(to);
  msg.setSubject(subject);
  if (inReplyTo) {
    msg.setHeader('In-Reply-To', inReplyTo);
    msg.setHeader('References', inReplyTo);
  }
  msg.addMessage({ contentType: 'text/plain', data: text });
  msg.addMessage({ contentType: 'text/html', data: html });
  return msg.asRaw();
}

export async function handleFreeCheck(
  message: ForwardableEmailMessage,
  env: Env,
  sessionToken: string,
): Promise<{ result: string }> {
  const fromEmail = message.from;
  const domain = extractDomain(fromEmail);

  // 1. Parse Authentication-Results from inbound headers
  const auth = extractAuthResults(message.headers);

  // 2. Get DKIM selector (if present) for DNS lookup
  const dkimSelector = auth?.dkim?.selector ?? null;

  // 3. Live DNS lookup — SPF, DKIM (if selector known), DMARC
  const dns = await checkDomain(domain, dkimSelector);

  // 4. Build structured summary and format plain-English report
  const summary = buildSummary(domain, auth, dns);
  const reportText = formatCheckReport(fromEmail, summary, auth, dns);
  const reportHtml = buildFreeCheckHtml({ fromEmail, summary, auth, dns });

  // 5. Send reply
  const resolvedFrom = derivedFromEmail();
  if (!resolvedFrom) throw new Error('FROM_EMAIL not configured — complete the setup wizard first');
  const subject = `Email security check — ${domain}`;
  const raw = buildReplyRaw({ name: 'InboxAngel', addr: resolvedFrom }, fromEmail, subject, reportText, reportHtml, message.headers.get('message-id'));
  await message.reply(new EmailMessage(resolvedFrom, fromEmail, raw));

  // 6. Store result in D1 (best-effort — don't let DB failure break the email flow)
  try {
    await globals(env.DB).checkResults.insert({
      from_email: fromEmail,
      from_domain: domain,
      spf_result: (auth?.spf?.result ?? null) as any,
      spf_domain: auth?.spf?.domain ?? null,
      spf_record: dns.spf?.raw ?? null,
      spf_lookup_count: dns.spf?.lookup_count ?? null,
      dkim_result: (auth?.dkim?.result ?? null) as any,
      dkim_domain: auth?.dkim?.domain ?? null,
      dmarc_result: (auth?.dmarc?.result ?? null) as any,
      dmarc_policy: (dns.dmarc?.policy ?? null) as any,
      dmarc_record: dns.dmarc?.raw ?? null,
      overall_status: summary.status,
      report_sent: 1,
      session_token: sessionToken,
    });
  } catch (err) {
    console.error('free-check: D1 insert failed', err);
  }

  return { result: summary.status };
}
