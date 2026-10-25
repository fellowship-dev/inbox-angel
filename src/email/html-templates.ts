// Branded HTML email templates for all outbound report types.
// All templates use inline CSS (no <style> blocks) for email-client compatibility.
// Plain-text versions are generated separately and passed alongside HTML in multipart/alternative.

import type { DomainWeeklyStat, FailingSource } from '@inbox-angel/db';
import { CheckSummary, DO_IT_FOR_YOU, doItForYouUrl, fixSteps, HELP_LINE, OverallStatus, retentionSentence, SHARE_IT, shareLinks } from './report-formatter';
import { DomainChange } from '../monitor/check';
import { DnsCheckResult } from './dns-check';
import { AuthResultsHeader } from './parse-headers';
import { DEFAULT_BRAND_COLOR, type Brand } from '../tenancy/context';

const DEFAULT_BRAND: Readonly<Brand> = { color: DEFAULT_BRAND_COLOR };

// ── Primitives ────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(label: string, color: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:600;background:${color};color:#fff;">${esc(label)}</span>`;
}

function passBadge(pass: boolean): string {
  return pass ? badge('PASS', '#16a34a') : badge('FAIL', '#dc2626');
}

function policyBadge(policy: string | null): string {
  if (policy === 'reject')     return badge('reject', '#16a34a');
  if (policy === 'quarantine') return badge('quarantine', '#d97706');
  if (policy === 'none')       return badge('none', '#dc2626');
  return badge('not set', '#dc2626');
}

function severityBadge(s: DomainChange['severity']): string {
  if (s === 'improved') return badge('improved', '#16a34a');
  if (s === 'degraded') return badge('degraded', '#dc2626');
  return badge('changed', '#d97706');
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

// ── Shared layout ─────────────────────────────────────────────

function htmlLayout(title: string, bodyHtml: string, brand: Brand): string {
  const accent = esc(brand.color);
  const logo = brand.logoUrl;
  const logoHtml = logo
    ? `<img src="${esc(logo)}" alt="InboxAngel" style="height:32px;vertical-align:middle;margin-right:8px;">`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#111827;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:24px 8px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:6px;overflow:hidden;max-width:600px;">
  <tr><td style="background:${accent};padding:16px 24px;">
    <span style="color:#fff;font-size:16px;font-weight:700;">${logoHtml}InboxAngel</span>
  </td></tr>
  <tr><td style="padding:24px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;text-align:center;">
    InboxAngel — automated email security monitoring
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Plain letter (onboarding sequence) ────────────────────────

export type LetterBlock = string | { heading: string } | { list: string[] } | { cta: { label: string; url: string } };

/** A plain, text-first letter in the shared brand layout: paragraphs, headings, lists and one call-to-action button. */
export function buildLetterHtml(p: { title: string; blocks: LetterBlock[]; brand?: Brand }): string {
  const brand = p.brand ?? DEFAULT_BRAND;
  const body = p.blocks.map((b) => {
    if (typeof b === 'string') return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">${esc(b)}</p>`;
    if ('heading' in b) return `<h2 style="margin:20px 0 8px;font-size:16px;">${esc(b.heading)}</h2>`;
    if ('list' in b) return `<ul style="margin:0 0 14px;padding-left:20px;font-size:15px;line-height:1.6;">${b.list.map((i) => `<li style="margin-bottom:6px;">${esc(i)}</li>`).join('')}</ul>`;
    return `<p style="margin:20px 0;"><a href="${esc(b.cta.url)}" style="display:inline-block;padding:10px 18px;border-radius:4px;background:${esc(brand.color)};color:#fff;font-size:15px;font-weight:600;text-decoration:none;">${esc(b.cta.label)}</a></p>`;
  }).join('\n');
  return htmlLayout(p.title, body, brand);
}

/** The same letter as plain text. */
export function buildLetterText(blocks: LetterBlock[]): string {
  return blocks.map((b) => {
    if (typeof b === 'string') return b;
    if ('heading' in b) return b.heading.toUpperCase();
    if ('list' in b) return b.list.map((i) => `- ${i}`).join('\n');
    return `${b.cta.label}: ${b.cta.url}`;
  }).join('\n\n');
}

// ── Weekly digest ─────────────────────────────────────────────

function domainSection(
  stat: DomainWeeklyStat,
  sources: FailingSource[],
  ruaAddress: string,
): string {
  let html = `<h3 style="margin:20px 0 8px;font-size:15px;color:#111827;">${esc(stat.domain)}</h3>`;
  html += `<p style="margin:0 0 8px;">DMARC policy: ${policyBadge(stat.dmarc_policy)}</p>`;

  if (stat.total_messages === 0) {
    html += `<p style="color:#6b7280;">No reports received this week. Verify <code>rua=mailto:${esc(ruaAddress)}</code> is in your DMARC record.</p>`;
    return html;
  }

  html += `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:8px;">
<tr style="background:#f9fafb;font-weight:600;"><td>Messages</td><td>Passed</td><td>Failed</td></tr>
<tr><td>${stat.total_messages.toLocaleString()}</td>
<td style="color:#16a34a;">${stat.pass_messages.toLocaleString()} (${pct(stat.pass_messages, stat.total_messages)})</td>
<td style="color:#dc2626;">${stat.fail_messages.toLocaleString()} (${pct(stat.fail_messages, stat.total_messages)})</td></tr>
</table>`;

  if (sources.length > 0) {
    html += `<p style="font-weight:600;margin:8px 0 4px;">Top failing sources:</p>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;">
<tr style="background:#f9fafb;font-weight:600;"><td>IP</td><td>From</td><td>Failures</td></tr>`;
    for (const s of sources) {
      html += `<tr><td>${esc(s.source_ip)}</td><td>${esc(s.header_from ?? '—')}</td><td>${s.total.toLocaleString()}</td></tr>`;
    }
    html += '</table>';
  }

  return html;
}

export interface WeeklyDigestHtmlParams {
  recipientName: string;
  stats: DomainWeeklyStat[];
  sourcesByDomain: Map<number, FailingSource[]>;
  weekLabel: string;
  ruaAddress: string;
  reportsDomain: string;
  latestVersion: string | null;
  currentVersion: string;
  brand?: Brand;
}

export function buildWeeklyDigestHtml(p: WeeklyDigestHtmlParams): string {
  let body = `<h2 style="margin:0 0 16px;font-size:18px;">DMARC Weekly Digest</h2>
<p style="margin:0 0 16px;">Hi ${esc(p.recipientName)}, here&rsquo;s your summary for the week of <strong>${esc(p.weekLabel)}</strong>.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">`;

  for (const stat of p.stats) {
    body += domainSection(stat, p.sourcesByDomain.get(stat.domain_id) ?? [], p.ruaAddress);
    body += '<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;">';
  }

  const weak = p.stats.filter(s => s.dmarc_policy === 'none' || !s.dmarc_policy);
  if (weak.length > 0) {
    body += `<p style="background:#fef9c3;border:1px solid #fde047;border-radius:4px;padding:12px;margin:16px 0;">
<strong>${esc(weak.map(s => s.domain).join(', '))}</strong> ${weak.length === 1 ? 'is' : 'are'} not enforcing DMARC.
<br>Want us to fix it? <a href="https://${esc(p.reportsDomain.replace(/^reports\./, ''))}">Sign up for InboxAngel</a>.
</p>`;
  }

  if (p.latestVersion && p.latestVersion !== p.currentVersion) {
    body += `<p style="font-size:12px;color:#6b7280;">Update available: v${esc(p.latestVersion)} (you're on v${esc(p.currentVersion)})</p>`;
  }

  return htmlLayout(`DMARC Weekly Digest — ${p.weekLabel}`, body, p.brand ?? DEFAULT_BRAND);
}

// ── Free-check report ─────────────────────────────────────────

const STATUS_COLOR: Readonly<Record<OverallStatus, string>> = {
  protected: '#16a34a',
  at_risk:   '#d97706',
  exposed:   '#dc2626',
};

const STATUS_LABEL: Readonly<Record<OverallStatus, string>> = {
  protected: 'Protected',
  at_risk:   'At risk',
  exposed:   'Exposed',
};

const STATUS_DESC: Readonly<Record<OverallStatus, string>> = {
  protected: 'This email passed all security checks.',
  at_risk:   'Your domain has partial protection — gaps remain.',
  exposed:   'Anyone can send email pretending to be you.',
};

export interface FreeCheckHtmlParams {
  fromEmail: string;
  summary: CheckSummary;
  auth: AuthResultsHeader | null;
  dns: DnsCheckResult;
  brand?: Brand;
  /** The line telling the sender about the follow-up emails, with its unsubscribe link. */
  disclosure?: { text: string; unsubscribeUrl: string };
  /** The marketing site (SITE_URL); no marketing link when unset. */
  siteUrl?: string | null;
  /** Days check results are kept, for the retention line when the sender is not enrolled. */
  retentionDays?: number;
  /** Not enrolled but already known (see CheckReportOptions.lead), for the retention line. */
  lead?: 'inactive' | 'suppressed';
  /** BOOKING_URL: where "or we do it for you" points first. */
  bookingUrl?: string | null;
}

export function buildFreeCheckHtml(p: FreeCheckHtmlParams): string {
  const { summary, auth, dns } = p;
  const color = STATUS_COLOR[summary.status];

  let body = `<div style="background:${color};color:#fff;border-radius:4px;padding:16px;margin-bottom:16px;">
<span style="font-size:18px;font-weight:700;">${esc(STATUS_LABEL[summary.status])}</span>
<span style="margin-left:12px;">${esc(STATUS_DESC[summary.status])}</span>
</div>
<p style="margin:0 0 12px;">Security check for <strong>${esc(summary.domain)}</strong></p>
<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px;">
<tr style="background:#f9fafb;font-weight:600;"><td>Check</td><td>Result</td><td>Detail</td></tr>
<tr style="border-top:1px solid #e5e7eb;">
  <td><strong>SPF</strong></td>
  <td>${passBadge(summary.spfPass)}</td>
  <td style="font-size:13px;color:#374151;">${summary.spfPass ? 'Authorized sender' : 'Unauthorized or no record'}</td>
</tr>
<tr style="border-top:1px solid #e5e7eb;">
  <td><strong>DKIM</strong></td>
  <td>${passBadge(summary.dkimPass)}</td>
  <td style="font-size:13px;color:#374151;">${summary.dkimPass ? 'Valid signature' : summary.dkimPresent ? 'Key found but email unsigned' : 'No signing key configured'}</td>
</tr>
<tr style="border-top:1px solid #e5e7eb;">
  <td><strong>DMARC</strong></td>
  <td>${passBadge(summary.dmarcPass)}</td>
  <td style="font-size:13px;color:#374151;">Policy: ${policyBadge(summary.dmarcPolicy)}</td>
</tr>
</table>`;

  // DNS records detail
  body += `<h3 style="margin:16px 0 8px;font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;">DNS Records</h3>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;">`;
  if (dns.spf) {
    body += `<tr><td style="padding-right:12px;color:#6b7280;">SPF</td><td>${esc(dns.spf.raw)}</td></tr>`;
  }
  if (dns.dmarc) {
    body += `<tr><td style="padding-right:12px;color:#6b7280;">DMARC</td><td>${esc(dns.dmarc.raw)}</td></tr>`;
  }
  for (const [label, msg] of [['SPF', dns.errors?.spf], ['DMARC', dns.errors?.dmarc], ['DKIM', dns.errors?.dkim]] as const) {
    if (msg) body += `<tr><td style="padding-right:12px;color:#6b7280;">${label}</td><td>could not be checked (DNS lookup failed)</td></tr>`;
  }
  if (dns.dkim) {
    body += `<tr><td style="padding-right:12px;color:#6b7280;">DKIM</td><td>selector: ${esc(auth?.dkim?.selector ?? 'found')}</td></tr>`;
  }
  body += '</table>';

  const steps = fixSteps(summary, auth, dns);
  if (steps.length > 0) {
    const accent = esc((p.brand ?? DEFAULT_BRAND).color);
    body += `<h3 style="margin:16px 0 8px;font-size:15px;">What to do next</h3>
<ol style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.5;">`;
    for (const st of steps) {
      body += `<li style="margin-bottom:8px;">${esc(st.text)}`;
      if (st.record) {
        body += `<div style="margin:6px 0;font-family:monospace;font-size:12px;background:#f3f4f6;padding:8px;border-radius:4px;">${esc(st.record.name)} &nbsp;${st.record.type}&nbsp; ${esc(st.record.value)}</div>`;
      }
      if (st.note) body += `<div style="font-size:13px;color:#374151;">${esc(st.note)}</div>`;
      body += '</li>';
    }
    body += '</ol>';
    const url = doItForYouUrl(p);
    body += url
      ? `<p style="margin:0;font-size:14px;">${DO_IT_FOR_YOU}: <a href="${esc(url)}" style="color:${accent};">${esc(url)}</a></p>`
      : `<p style="margin:0;font-size:14px;">${DO_IT_FOR_YOU}: reply to this email.</p>`;
  }

  const share = shareLinks(summary, p.siteUrl);
  if (share.length) {
    const accent = esc((p.brand ?? DEFAULT_BRAND).color);
    const links = share.map(l => `<a href="${esc(l.url)}" style="color:${accent};">${esc(l.label)}</a>`).join(' · ');
    body += `<p style="margin:16px 0 0;font-size:14px;">${SHARE_IT} (optional, nothing is posted unless you post it): ${links}</p>`;
  }

  if (p.disclosure) {
    body += `<p style="margin:16px 0 0;font-size:13px;color:#374151;">${esc(p.disclosure.text)} <a href="${esc(p.disclosure.unsubscribeUrl)}" style="color:#374151;">Unsubscribe</a></p>`;
  }

  const site = p.siteUrl ? ` <a href="${esc(p.siteUrl)}" style="color:#6b7280;">${esc(p.siteUrl.replace(/^https:\/\//, ''))}</a>` : '';
  body += `<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">${esc(retentionSentence({ retentionDays: p.retentionDays, enrolled: p.disclosure, lead: p.lead }))}${site}</p>
<p style="margin:16px 0 0;font-size:15px;font-weight:600;">${esc(HELP_LINE)}</p>`;

  return htmlLayout(`Email Security Check — ${summary.domain}`, body, p.brand ?? DEFAULT_BRAND);
}

// ── DNS change alert ──────────────────────────────────────────

export interface DnsAlertHtmlParams {
  domain: string;
  changes: DomainChange[];
  reportsDomain: string;
  brand?: Brand;
}

export function buildDnsAlertHtml(p: DnsAlertHtmlParams): string {
  const hasDegraded = p.changes.some(c => c.severity === 'degraded');
  const accent = (p.brand ?? DEFAULT_BRAND).color;

  let body = `<h2 style="margin:0 0 12px;font-size:18px;">Email security configuration changed</h2>
<p style="margin:0 0 16px;">We detected changes to the email security configuration of <strong>${esc(p.domain)}</strong>.</p>
<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px;">
<tr style="background:#f9fafb;font-weight:600;"><td>Field</td><td>Was</td><td>Now</td><td>Status</td></tr>`;

  for (const c of p.changes) {
    body += `<tr style="border-top:1px solid #e5e7eb;">
<td><strong>${esc(c.field)}</strong></td>
<td style="font-size:13px;color:#6b7280;">${esc(c.was || '(not set)')}</td>
<td style="font-size:13px;">${esc(c.now || '(removed)')}</td>
<td>${severityBadge(c.severity)}</td>
</tr>`;
  }

  body += '</table>';

  if (hasDegraded) {
    body += `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:12px;margin:0 0 12px;">
Some changes may leave your domain exposed to spoofing.
<a href="https://${esc(p.reportsDomain.replace(/^reports\./, ''))}" style="color:${esc(accent)};">Fix it with InboxAngel →</a>
</p>`;
  } else {
    body += `<p style="color:#6b7280;font-size:13px;">No action required — these look like improvements or routine updates.</p>`;
  }

  return htmlLayout(`${p.domain} email security updated`, body, p.brand ?? DEFAULT_BRAND);
}
