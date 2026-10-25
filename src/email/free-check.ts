// Free email security check handler.
// Triggered when an email arrives at check-{token}@reports.inboxangel.io.
// The token ties the inbound email to a browser session for front-end polling.
// Parses auth headers, does live DNS lookup, replies with plain-English report, stores result in D1.
//
// Delivery: message.reply() first. Cloudflare documents that reply() throws unless the incoming email has a valid DMARC
// result (and the reply goes to its sender, once, from the receiving domain), so a sender whose domain has no DMARC, or
// fails it, would get nothing. Then the same report goes out as a new email through the SEND_EMAIL binding (Cloudflare
// Email Service), which reaches any recipient once the sending domain is onboarded, but only to a sender the receiver's own
// results (AUTHSERV_ID / AUTHSERV_HEADER) show an SPF pass for: otherwise a forged envelope sender would have the report
// reflected at someone else. See docs/email-funnel.md.

import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage, Mailbox } from 'mimetext/browser';
import type { TenantContext } from '../tenancy/context';
import { extractAuthResults, parseAuthResults } from './parse-headers';
import { checkDomain } from './dns-check';
import { buildSummary, formatCheckReport } from './report-formatter';
import { buildFreeCheckHtml } from './html-templates';
import { globals } from '../db/scope';
import { proveSender, readAuthHeaders, spfPassesFor, trustedResults, type AuthHeaders } from './sender-proof';
import { enrollLead, type EnrollResult } from '../funnel/enroll';
import { DISCLOSURE } from '../funnel/copy';
import { unsubscribeUrl } from '../mail/compliance';
import { ownerMailer } from '../mail/mailer';
import { bookingUrl, replyTo as replyToAddress, siteUrl } from '../funnel/config';
import { retentionPolicy } from '../lifecycle/config';

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
  replyTo?: string | null,
): string {
  const msg = createMimeMessage();
  msg.setSender(from);
  msg.setRecipient(to);
  msg.setSubject(subject);
  if (replyTo) msg.setHeader('Reply-To', new Mailbox(replyTo));
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
 * Enrol the sender in the onboarding sequence. `disclosure` is the line for the reply, or null when they are not enrolled
 * (sequence off, address suppressed, no unsubscribe link possible, or the sender is not who it claims); `lead` is the
 * enrolment outcome when one was reached, so the report can state retention truthfully.
 *
 * The envelope sender of an email is easy to forge, and the sequence is mail to that address, so only a sender whose
 * own domain authenticated is enrolled, judged on the receiver's own results only, and only when AUTHSERV_ID is
 * configured (it fails closed: see sender-proof.ts). Everyone still gets the report.
 */
async function enrollAndDisclose(
  authHeaders: AuthHeaders,
  tenant: TenantContext,
  fromEmail: string,
  domain: string,
  summary: ReturnType<typeof buildSummary>,
): Promise<{ disclosure: { text: string; unsubscribeUrl: string } | null; lead: EnrollResult | null }> {
  try {
    const proof = proveSender(authHeaders, domain, tenant.env.AUTHSERV_ID, tenant.env.AUTHSERV_HEADER);
    if (!proof.ok) {
      console.warn(`[free-check] sender not enrolled in the sequence: ${proof.reason}`);
      return { disclosure: null, lead: null };
    }
    const link = await unsubscribeUrl(tenant.env, fromEmail);
    if (!link) return { disclosure: null, lead: null };
    const lead = await enrollLead(tenant.env, { email: fromEmail, domain, summary });
    return { disclosure: lead === 'enrolled' || lead === 'existing' ? { text: DISCLOSURE, unsubscribeUrl: link } : null, lead };
  } catch (err) {
    console.error('free-check: lead enrolment failed', err instanceof Error ? err.message : 'error');
    return { disclosure: null, lead: null };
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
  /** MAIL_REPLY_TO; no Reply-To when null. */
  replyTo: string | null;
  /** The SEND_EMAIL fallback may be used: the receiver's own results show an SPF pass for the envelope sender. */
  fallbackAllowed: boolean;
}

/** Deliver the report; true when reply() or the outbound send accepted it. Never throws: the check result is stored either way. */
async function deliverReport(message: ForwardableEmailMessage, tenant: TenantContext, r: Report): Promise<boolean> {
  const sender = { name: 'InboxAngel', addr: r.from };
  try {
    const raw = buildReplyRaw(sender, r.to, r.subject, r.text, r.html, r.inReplyTo, r.headers, r.replyTo);
    await message.reply(new EmailMessage(r.from, r.to, raw));
    return true;
  } catch (err) {
    console.warn(`[free-check] reply() refused: ${err instanceof Error ? err.message : 'error'}`);
  }
  if (!r.fallbackAllowed) {
    console.warn('free-check: report not delivered: reply() was refused and there is no SPF pass for the envelope sender in the receiver\'s own results (or AUTHSERV_ID / AUTHSERV_HEADER unset), so it may be forged');
    return false;
  }
  const mailer = ownerMailer(tenant.env);
  if (!mailer) {
    console.error('free-check: report not delivered: reply() was refused and no SEND_EMAIL binding is configured');
    return false;
  }
  const threading: Record<string, string> = r.inReplyTo ? { 'In-Reply-To': r.inReplyTo, References: r.inReplyTo } : {};
  const res = await mailer.send({
    from: { name: sender.name, email: r.from }, to: r.to, subject: r.subject, text: r.text, html: r.html,
    headers: { ...threading, ...r.headers }, ...(r.replyTo ? { replyTo: r.replyTo } : {}),
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

  // 1. Authentication-Results. The receiver's own header (topmost of the configured kind, naming AUTHSERV_ID) when there
  //    is one; otherwise every header joined, which includes any the sender wrote. That is only used on the reply() path,
  //    which Cloudflare allows only after a DMARC pass; the SEND_EMAIL fallback needs the trusted header (step 5).
  const authHeaders = await readAuthHeaders(message.raw);
  const trusted = trustedResults(authHeaders, tenant.env.AUTHSERV_ID, tenant.env.AUTHSERV_HEADER);
  const auth = trusted ? parseAuthResults(trusted) : extractAuthResults(message.headers);

  // 2. Get DKIM selector (if present) for DNS lookup
  const dkimSelector = auth?.dkim?.selector ?? null;

  // 3. Live DNS lookup — SPF, DKIM (if selector known), DMARC
  const dns = await checkDomain(domain, dkimSelector);

  // 4. Build structured summary, then enrol the sender in the onboarding sequence (hosted by default; self-host only
  //    when switched on), so the report can say so and state retention truthfully.
  const summary = buildSummary(domain, auth, dns);
  const { disclosure, lead } = await enrollAndDisclose(authHeaders, tenant, fromEmail, domain, summary);
  const knownLead = lead === 'inactive' || lead === 'suppressed' ? lead : undefined;

  // 4b. Plain-English report: links use the marketing site (SITE_URL, never the Worker's origin); the closing states what
  //     is kept and for how long, and ends with the help line.
  const opts = {
    siteUrl: siteUrl(tenant.env), bookingUrl: bookingUrl(tenant.env),
    retentionDays: retentionPolicy(tenant.env).checkResultsDays, enrolled: disclosure ?? undefined, lead: knownLead,
  };
  const reportText = formatCheckReport(fromEmail, summary, auth, dns, opts);
  const reportHtml = buildFreeCheckHtml({ fromEmail, summary, auth, dns, brand: tenant.brand, disclosure: opts.enrolled, siteUrl: opts.siteUrl, bookingUrl: opts.bookingUrl, retentionDays: opts.retentionDays, lead: knownLead });

  // 5. Send the report: reply() first, a new email through SEND_EMAIL when reply() is refused.
  const resolvedFrom = tenant.settings.fromEmail;
  if (!resolvedFrom) throw new Error('FROM_EMAIL not configured — complete the setup wizard first');
  const subject = `Email security check — ${domain}`;
  const messageId = message.headers.get('message-id')?.trim() ?? null;
  const inReplyTo = messageId && messageId.length <= 998 && /^<[^<>\s]+>$/.test(messageId) ? messageId : null;
  const listHeaders: Record<string, string> = disclosure
    ? { 'List-Unsubscribe': `<${disclosure.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : {};
  const sent = await deliverReport(message, tenant, {
    from: resolvedFrom, to: fromEmail, subject, text: reportText, html: reportHtml, inReplyTo, headers: listHeaders,
    replyTo: replyToAddress(tenant.env), fallbackAllowed: spfPassesFor(trusted, domain),
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
