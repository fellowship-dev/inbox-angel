// "First report received" notification — fires once per domain when
// the very first DMARC aggregate report is successfully stored.
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Falls back to console.log if binding is absent.

import type { TenantContext } from '../tenancy/context';

export interface ReportStats {
  totalMessages: number;
  passMessages: number;
  failMessages: number;
  sourceCount: number;
}

// ── Formatting ────────────────────────────────────────────────

export function buildFirstReportBody(
  recipientName: string,
  domain: string,
  stats: ReportStats,
  dashboardUrl: string,
): string {
  const passRate = stats.totalMessages > 0
    ? Math.round((stats.passMessages / stats.totalMessages) * 100)
    : 0;

  const lines: string[] = [
    `Hi ${recipientName},`,
    '',
    `Great news! We just received the first DMARC aggregate report for ${domain}.`,
    '',
    'Here are the highlights:',
    `  - ${stats.totalMessages.toLocaleString()} email(s) analyzed`,
    `  - ${stats.sourceCount.toLocaleString()} sending source(s) detected`,
    `  - ${passRate}% pass rate (${stats.passMessages.toLocaleString()} passed, ${stats.failMessages.toLocaleString()} failed)`,
    '',
    `View the full report on your dashboard: ${dashboardUrl}`,
    '',
    'It can take 24-48 hours after publishing your DMARC record for reports to start arriving.',
    'Now that the first one is in, you can expect daily reports from major mailbox providers.',
    '',
    '—',
    'InboxAngel notifications',
  ];

  return lines.join('\n');
}

// ── Delivery ──────────────────────────────────────────────────

export async function sendFirstReportNotification(
  tenant: TenantContext,
  domain: string,
  reportStats: ReportStats,
): Promise<void> {
  // Resolve dashboard URL: custom domain > {worker}.{subdomain}.workers.dev
  const customDomain = await tenant.scope.settings.get('custom_domain');
  let dashboardUrl: string;
  if (customDomain?.value) {
    dashboardUrl = `https://${customDomain.value}`;
  } else {
    const workerName = tenant.workerName;
    const subdomain = await tenant.workersSubdomain();
    dashboardUrl = subdomain
      ? `https://${workerName}.${subdomain}.workers.dev`
      : `https://${workerName}.workers.dev`;
  }

  // Get admin user email
  const admin = await tenant.scope.team.firstAdmin();
  if (!admin) {
    console.log('[first-report] no admin user found — skipping notification');
    return;
  }

  const subject = `\u{1F389} First DMARC report received for ${domain}`;
  const body = buildFirstReportBody(admin.name ?? 'there', domain, reportStats, dashboardUrl);

  if (!tenant.env.SEND_EMAIL) {
    console.log(`[first-report] SEND_EMAIL binding not configured — would send to ${admin.email}: ${subject}\n${body}`);
    return;
  }

  try {
    await tenant.env.SEND_EMAIL.send({
      from: { name: 'InboxAngel', email: tenant.settings.fromEmail! },
      to: [admin.email],
      subject,
      text: body,
    });
    console.log(`[first-report] sent notification to ${admin.email} for ${domain}`);
  } catch (e) {
    console.error(`[first-report] send failed for ${admin.email}:`, e);
  }
}
