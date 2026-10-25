// Free email security check handler.
// Triggered when an email arrives at check-{token}@reports.inboxangel.io.
// The token ties the inbound email to a browser session for front-end polling.
// Parses auth headers, does live DNS lookup, replies with plain-English report, stores result in D1.
//
// Delivery: message.reply() first. Cloudflare documents that reply() throws unless the incoming email has a valid DMARC
// result (and the reply goes to its sender, once, from the receiving domain), so a sender whose domain has no DMARC, or
// fails it, would get nothing. Then the same report goes out as a new email through the SEND_EMAIL binding (Cloudflare
// Email Service), which reaches any recipient once the sending domain is onboarded. See docs/email-funnel.md.

import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext/browser';
import type { TenantContext } from '../tenancy/context';
import { extractAuthResults } from './parse-headers';
import { checkDomain } from './dns-check';
import { buildSummary, formatCheckReport } from './report-formatter';
import { buildFreeCheckHtml } from './html-templates';
import { globals } from '../db/scope';
import { proveSender, readAuthHeaders } from './sender-proof';
import { enrollLead } from '../funnel/enroll';
import { DISCLOSURE } from '../funnel/copy';
import { unsubscribeUrl } from '../mail/compliance';
import { ownerMailer } from '../mail/mailer';

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
  extraHeaders: Record<string, string> = {},
): string {
  const msg = createMimeMessage();
  msg.setSender(from);
  msg.setRecipient(to);
  msg.setSubject(subject);
  if (inReplyTo) {
    msg.setHeader('In-Reply-To', inReplyTo);
    msg.setHeader('References', inReplyTo);
  }
  for (const [k, v] of Object.entries(extraHeaders)) msg.setHeader(k, v);
  msg.addMessage({ contentType: 'text/plain', data: text });
  msg.addMessage({ contentType: 'text/html', data: html });
  return msg.asRaw();
}

/**
 * Enrol the sender in the onboarding sequence and return the disclosure line for the reply, or null when they are
 * not enrolled (sequence off, address suppressed, no unsubscribe link possible, or the sender is not who it claims).
 *
 * The envelope sender of an email is easy to forge, and the sequence is mail to that address, so only a sender whose
 * own domain authenticated is enrolled, judged on the receiver's own results only, and only when AUTHSERV_ID is
 * configured (it fails closed: see sender-proof.ts). Everyone still gets the report.
 */
async function enrollAndDisclose(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  fromEmail: string,
  domain: string,
  summary: ReturnType<typeof buildSummary>,
): Promise<{ text: string; unsubscribeUrl: string } | null> {
  try {
    const proof = proveSender(await readAuthHeaders(message.raw), domain, tenant.env.AUTHSERV_ID, tenant.env.AUTHSERV_HEADER);
    if (!proof.ok) {
      console.warn(`[free-check] sender not enrolled in the sequence: ${proof.reason}`);
      return null;
    }
    const link = await unsubscribeUrl(tenant.env, fromEmail);
    if (!link) return null;
    const outcome = await enrollLead(tenant.env, { email: fromEmail, domain, summary });
    return outcome === 'enrolled' || outcome === 'existing' ? { text: DISCLOSURE, unsubscribeUrl: link } : null;
  } catch (err) {
    console.error('free-check: lead enrolment failed', err instanceof Error ? err.message : 'error');
    return null;
  }
}

interface Report {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  inReplyTo: string | null;
  headers: Record<string, string>;
}

/** Deliver the report; true when reply() or the outbound send accepted it. Never throws: the check result is stored either way. */
async function deliverReport(message: ForwardableEmailMessage, tenant: TenantContext, r: Report): Promise<boolean> {
  const sender = { name: 'InboxAngel', addr: r.from };
  try {
    const raw = buildReplyRaw(sender, r.to, r.subject, r.text, r.html, r.inReplyTo, r.headers);
    await message.reply(new EmailMessage(r.from, r.to, raw));
    return true;
  } catch (err) {
    console.warn(`[free-check] reply() refused, sending the report as a new email: ${err instanceof Error ? err.message : 'error'}`);
  }
  const mailer = ownerMailer(tenant.env);
  if (!mailer) {
    console.error('free-check: report not delivered: reply() was refused and no SEND_EMAIL binding is configured');
    return false;
  }
  const threading: Record<string, string> = r.inReplyTo ? { 'In-Reply-To': r.inReplyTo, References: r.inReplyTo } : {};
  const res = await mailer.send({
    from: { name: sender.name, email: r.from }, to: r.to, subject: r.subject, text: r.text, html: r.html,
    headers: { ...threading, ...r.headers },
  });
  if (!res.ok) console.error(`free-check: report not delivered: reply() was refused and SEND_EMAIL failed (${res.error})`);
  return res.ok;
}

export async function handleFreeCheck(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
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
  let reportText = formatCheckReport(fromEmail, summary, auth, dns);

  // 4b. Onboarding sequence: enrol the sender (hosted by default; self-host only when switched on) and say so in the reply.
  const disclosure = await enrollAndDisclose(message, tenant, fromEmail, domain, summary);
  if (disclosure) reportText += `\n\n${disclosure.text}\nUnsubscribe: ${disclosure.unsubscribeUrl}\n`;
  const reportHtml = buildFreeCheckHtml({ fromEmail, summary, auth, dns, brand: tenant.brand, disclosure: disclosure ?? undefined });

  // 5. Send the report: reply() first, a new email through SEND_EMAIL when reply() is refused.
  const resolvedFrom = tenant.settings.fromEmail;
  if (!resolvedFrom) throw new Error('FROM_EMAIL not configured — complete the setup wizard first');
  const subject = `Email security check — ${domain}`;
  const inReplyTo = message.headers.get('message-id');
  const listHeaders: Record<string, string> = disclosure
    ? { 'List-Unsubscribe': `<${disclosure.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : {};
  const sent = await deliverReport(message, tenant, {
    from: resolvedFrom, to: fromEmail, subject, text: reportText, html: reportHtml, inReplyTo, headers: listHeaders,
  });

  // 6. Store result in D1 (best-effort — don't let DB failure break the email flow)
  try {
    await globals(tenant.db).checkResults.insert({
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
      report_sent: sent ? 1 : 0,
      session_token: sessionToken,
    });
  } catch (err) {
    console.error('free-check: D1 insert failed', err);
  }

  return { result: summary.status };
}
