// Change notification emails for domain monitoring.
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Falls back to console.log if binding is absent (wrangler dev has no local send_email support).

import { DomainChange } from './check';
import type { TenantContext } from '../tenancy/context';
import { buildDnsAlertHtml } from '../email/html-templates';

const SEVERITY_EMOJI: Readonly<Record<DomainChange['severity'], string>> = {
  improved: '✅',
  degraded: '🚨',
  changed: '⚠️',
};

function buildEmailBody(domain: string, changes: DomainChange[], rd: string): string {
  const lines: string[] = [
    `We detected changes to the email security configuration of ${domain}.`,
    '',
    ...changes.map(c =>
      `${SEVERITY_EMOJI[c.severity]} ${c.field}\n   Was: ${c.was || '(not set)'}\n   Now: ${c.now || '(removed)'}`
    ),
    '',
  ];

  const hasDegraded = changes.some(c => c.severity === 'degraded');
  if (hasDegraded) {
    lines.push(
      'Some of these changes may leave your domain exposed to spoofing.',
      'Want us to fix it for you? Reply to this email or sign up at https://' + rd.replace(/^reports\./, ''),
      '',
    );
  } else {
    lines.push('No action required — these look like improvements or routine updates.');
    lines.push('');
  }

  lines.push('—');
  lines.push('InboxAngel domain monitoring');
  lines.push(`To manage alerts for ${domain}: open your dashboard → Domains → ${domain} → Settings.`);

  return lines.join('\n');
}

export async function sendChangeNotification(
  email: string,
  domain: string,
  changes: DomainChange[],
  tenant: TenantContext,
): Promise<void> {
  const hasDegraded = changes.some(c => c.severity === 'degraded');
  const subject = hasDegraded
    ? `⚠️ ${domain} email security degraded`
    : `${domain} email security updated`;

  const rd = tenant.settings.reportsDomain!;
  const body = buildEmailBody(domain, changes, rd);
  const html = buildDnsAlertHtml({ domain, changes, reportsDomain: rd, brand: tenant.brand });

  if (!tenant.env.SEND_EMAIL) {
    console.log(`[notify] SEND_EMAIL binding not configured — would send to ${email}: ${subject}\n${body}`);
    return;
  }

  try {
    await tenant.env.SEND_EMAIL.send({
      from: { name: 'InboxAngel', email: tenant.settings.fromEmail! },
      to: [email],
      subject,
      text: body,
      html,
    });
  } catch (e) {
    console.error(`[notify] send failed for ${email}:`, e);
  }
}

/**
 * Tell the workspace's owner and admins that a Cloudflare connection stopped working: DNS changes for the
 * domains behind it fail until someone reconnects. Same channel as the change alerts (SEND_EMAIL, else a log line).
 */
export async function notifyConnectionBroken(
  tenant: TenantContext,
  info: { id: string; label: string; detail: string },
): Promise<void> {
  const team = await tenant.scope.team.list();
  const to = team.filter(m => m.role === 'owner' || m.role === 'admin').map(m => m.email);
  const subject = `Cloudflare connection "${info.label}" needs attention`;
  const body = [
    `Inbox Angel can no longer use your Cloudflare connection "${info.label}".`,
    '',
    info.detail,
    '',
    'DNS changes for the domains managed through it will fail until it is reconnected:',
    'open your dashboard → Settings → Cloudflare and reconnect it.',
    '',
    '—',
    'InboxAngel',
  ].join('\n');

  if (!tenant.env.SEND_EMAIL || !tenant.settings.fromEmail || to.length === 0) {
    console.warn(`[connections] ${tenant.workspaceId}: connection ${info.id} is broken (${info.detail}); no alert email could be sent`);
    return;
  }
  for (const email of to) {
    try {
      await tenant.env.SEND_EMAIL.send({ from: { name: 'InboxAngel', email: tenant.settings.fromEmail }, to: [email], subject, text: body });
    } catch (e) {
      console.error(`[connections] alert to ${email} failed:`, e instanceof Error ? e.name : 'error');
    }
  }
}
