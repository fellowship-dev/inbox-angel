import type { ReportModel } from '@inbox-angel/report';
import type { Fix } from '../analytics/fixes';
import type { Remediation } from './contracts';

/** Reuse catalog identities and values; these are proposals, never DNS execution. */
export function buildRemediation(dns: ReportModel, senderFixes: Fix[] = []): Remediation[] {
  const catalog = dns.findings.filter(f => f.status === 'confirmed').map(f => {
    const changes = dns.steps.filter(s => s.finding === f.id);
    return {
      finding: f.id, observation: f.evidence, impact: f.fix.why,
      steps: f.fix.steps, prerequisites: f.fix.needsFromProvider,
      changes, verification: changes.length ? changes.map(s => `${s.verify.query}: ${s.verify.match}`) : [`Re-run the domain report and check ${f.id}.`],
    };
  });
  // Private DMARC evidence adds sender-specific advice; it does not invent a second DNS catalog.
  const senders = senderFixes.map(f => ({
    finding: f.id, observation: [f.detail, `${f.affected_messages} observed messages affected`],
    impact: f.title, steps: [
      ...f.steps.map(step => step.startsWith('Send a test message') ? `After separately authorizing a test message, check the Sender inventory again after new DMARC reports arrive.` : step),
      ...(f.sender.provider_id === 'amazon-ses' && f.kind === 'authorize-sender' ? ['If you also need SPF alignment, configure a custom MAIL FROM subdomain in the SES identity and region used for sending. Obtain its MX and SPF values from that SES account; default amazonses.com MAIL FROM authentication does not align with your From domain.'] : []),
    ],
    prerequisites: f.records.length ? [] : ['Obtain account-specific DKIM records and any custom MAIL FROM values from the sending provider; do not guess them.'],
    changes: [], verification: ['Send only after separate authorization, then inspect new DMARC reports for aligned SPF or DKIM.'],
  }));
  return [...catalog, ...senders];
}
