// Weekly DMARC digest emails.
// Runs every Monday (cron "0 9 * * 1") and sends a summary of
// the past 7 days of DMARC aggregate reports.
//
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Recipients must be verified destination addresses in CF Email Routing.
// Falls back to console.log if binding is absent (wrangler dev has no local send_email support).

import { getWeeklyDomainStats, getTopFailingSources, DomainWeeklyStat, FailingSource } from '../db/queries';
import { reportsDomain, fromEmail } from '../env-utils';
import { buildWeeklyDigestHtml } from '../email/html-templates';
import { version } from '../../package.json';

const GH_RAW = 'https://raw.githubusercontent.com/fellowship-dev/inbox-angel/main/package.json';
const RELEASE_URL = 'https://github.com/fellowship-dev/inbox-angel/releases/latest';

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(GH_RAW);
    if (!res.ok) return null;
    const pkg = await res.json() as { version: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface DigestEnv {
  DB: D1Database;
  SEND_EMAIL?: SendEmail;
}

// ── Formatting ────────────────────────────────────────────────

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function policyBadge(policy: string | null): string {
  if (policy === 'reject')     return 'reject ✅';
  if (policy === 'quarantine') return 'quarantine ⚠️';
  if (policy === 'none')       return 'none ❌';
  return '(not set) ❌';
}

function formatDomainSection(
  stat: DomainWeeklyStat,
  sources: FailingSource[],
  ruaAddress: string,
): string {
  const lines: string[] = [`Domain: ${stat.domain}`];
  lines.push(`DMARC policy: ${policyBadge(stat.dmarc_policy)}`);

  if (stat.total_messages === 0) {
    lines.push('No reports received this week.');
    lines.push(`Check that rua=mailto:${ruaAddress} is in your DMARC record.`);
    return lines.join('\n');
  }

  lines.push(`Messages this week: ${stat.total_messages.toLocaleString()}`);
  lines.push(`  ✅ Passed: ${stat.pass_messages.toLocaleString()} (${pct(stat.pass_messages, stat.total_messages)})`);
  lines.push(`  ❌ Failed: ${stat.fail_messages.toLocaleString()} (${pct(stat.fail_messages, stat.total_messages)})`);

  if (sources.length > 0) {
    lines.push('');
    lines.push('Top failing sources:');
    for (const s of sources) {
      const from = s.header_from ? ` (${s.header_from})` : '';
      lines.push(`  ${s.source_ip}${from} — ${s.total.toLocaleString()} failures`);
    }
  }

  return lines.join('\n');
}

export function buildDigestBody(
  recipientName: string,
  stats: DomainWeeklyStat[],
  sourcesByDomain: Map<number, FailingSource[]>,
  weekLabel: string,
  ruaAddress: string,
  reportsDomain: string,
  latestVersion: string | null = null,
): string {
  const lines: string[] = [
    `Hi ${recipientName},`,
    '',
    `Here's your DMARC summary for the week of ${weekLabel}.`,
    '',
  ];

  for (const stat of stats) {
    lines.push(formatDomainSection(stat, sourcesByDomain.get(stat.domain_id) ?? [], ruaAddress));
    lines.push('');
  }

  // CTA for degraded domains (policy = none or missing)
  const weak = stats.filter(s => s.dmarc_policy === 'none' || !s.dmarc_policy);
  if (weak.length > 0) {
    lines.push(`${weak.map(s => s.domain).join(', ')} ${weak.length === 1 ? 'is' : 'are'} not enforcing DMARC.`);
    lines.push(`Want us to fix it for you? Visit https://${reportsDomain.replace(/^reports\./, '')}`);
    lines.push('');
  }

  if (latestVersion && latestVersion !== version) {
    lines.push('─────────────────────────────');
    lines.push(`📦 Update available: v${latestVersion} (you're on v${version})`);
    lines.push(`${RELEASE_URL}`);
    lines.push('');
  }

  lines.push('—');
  lines.push('InboxAngel weekly digest');

  return lines.join('\n');
}

// ── Delivery ──────────────────────────────────────────────────

async function sendDigest(
  email: string,
  subject: string,
  body: string,
  html: string,
  env: DigestEnv,
): Promise<void> {
  if (!env.SEND_EMAIL) {
    console.log(`[digest] SEND_EMAIL binding not configured — would send to ${email}: ${subject}\n${body}`);
    return;
  }

  try {
    await env.SEND_EMAIL.send({
      from: { name: 'InboxAngel', email: fromEmail()! },
      to: [email],
      subject,
      text: body,
      html,
    });
  } catch (e) {
    console.error(`[digest] send failed for ${email}:`, e);
  }
}

// ── Main ──────────────────────────────────────────────────────

export async function sendWeeklyDigests(env: DigestEnv, now = Date.now()): Promise<void> {
  const since = Math.floor(now / 1000) - 7 * 24 * 60 * 60; // 7 days ago in Unix seconds
  const weekLabel = new Date(since * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const rd = reportsDomain()!;
  const ruaAddress = `rua@${rd}`;

  const latestVersion = await fetchLatestVersion();
  if (latestVersion && latestVersion !== version) {
    console.log(`[digest] update available: v${latestVersion} (running v${version})`);
  }

  // Single-tenant: get admin user email for digest delivery
  const admin = await env.DB.prepare(`SELECT email, name FROM users WHERE role = 'admin' LIMIT 1`).first<{ email: string; name: string }>();
  if (!admin) {
    console.log('[digest] no admin user found — skipping weekly digest');
    return;
  }

  try {
    const { results: stats } = await getWeeklyDomainStats(env.DB, since);
    if (stats.length === 0) {
      console.log('[digest] no domains — skipping weekly digest');
      return;
    }

    // Fetch top failing sources for domains that had failures
    const sourcesByDomain = new Map<number, FailingSource[]>();
    for (const stat of stats) {
      if (stat.fail_messages > 0) {
        const { results: sources } = await getTopFailingSources(env.DB, stat.domain_id, since);
        sourcesByDomain.set(stat.domain_id, sources);
      }
    }

    const body = buildDigestBody(admin.name ?? 'there', stats, sourcesByDomain, weekLabel, ruaAddress, rd, latestVersion);
    const html = buildWeeklyDigestHtml({
      recipientName: admin.name ?? 'there',
      stats,
      sourcesByDomain,
      weekLabel,
      ruaAddress,
      reportsDomain: rd,
      latestVersion,
      currentVersion: version,
    });
    const hasIssues = stats.some(s => s.fail_messages > 0 || !s.dmarc_policy || s.dmarc_policy === 'none');
    const subject = hasIssues
      ? `⚠️ DMARC Weekly Digest — action needed`
      : `✅ DMARC Weekly Digest — all clear`;

    await sendDigest(admin.email, subject, body, html, env);
    console.log(`[digest] sent to ${admin.email} (${stats.length} domain(s))`);
  } catch (e) {
    console.error('[digest] error:', e);
  }
}
