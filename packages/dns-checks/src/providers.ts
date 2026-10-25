// Detect email providers / sending services from MX hosts and SPF includes.

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'mailbox' | 'sender' | 'both';
}

interface Signature extends ProviderInfo {
  mx?: RegExp[];
  spf?: RegExp[];
}

const SIGNATURES: Signature[] = [
  { id: 'google-workspace', name: 'Google Workspace', kind: 'mailbox', mx: [/(^|\.)(google|googlemail)\.com$/, /(^|\.)aspmx\.l\.google\.com$/], spf: [/^_spf\.google\.com$/, /^spf\.google\.com$/] },
  { id: 'microsoft-365', name: 'Microsoft 365', kind: 'mailbox', mx: [/\.mail\.protection\.outlook\.com$/, /\.mail\.eo\.outlook\.com$/], spf: [/^spf\.protection\.outlook\.com$/] },
    { id: 'resend', name: 'Resend', kind: 'sender', spf: [/(^|\.)resend\.com$/] },
  { id: 'postmark', name: 'Postmark', kind: 'sender', spf: [/^spf\.mtasv\.net$/, /(^|\.)postmarkapp\.com$/] },
  { id: 'amazon-ses', name: 'Amazon SES', kind: 'sender', spf: [/^amazonses\.com$/, /\.amazonses\.com$/], mx: [/\.amazonses\.com$/, /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/] },
  { id: 'sendgrid', name: 'SendGrid', kind: 'sender', spf: [/^sendgrid\.net$/, /\.sendgrid\.net$/] },
  { id: 'mailgun', name: 'Mailgun', kind: 'sender', spf: [/^mailgun\.org$/, /\.mailgun\.org$/], mx: [/\.mailgun\.org$/] },
  { id: 'zoho', name: 'Zoho Mail', kind: 'mailbox', mx: [/(^|\.)zoho\.(com|eu|in|com\.au|jp)$/, /(^|\.)zohomail\.[a-z.]+$/], spf: [/(^|\.)zoho\.(com|eu|in|com\.au|jp)$/, /(^|\.)zohomail\.[a-z.]+$/] },
  { id: 'shopify', name: 'Shopify Email', kind: 'sender', spf: [/^shops\.shopify\.com$/, /(^|\.)shopify\.com$/], mx: [/(^|\.)shopifyemail\.com$/] },
  { id: 'mailchimp-mandrill', name: 'Mailchimp / Mandrill', kind: 'sender', spf: [/^spf\.mandrillapp\.com$/, /^servers\.mcsv\.net$/, /(^|\.)mailchimp\.com$/] },
  { id: 'proton', name: 'Proton Mail', kind: 'mailbox', mx: [/^mail(strong)?\.protonmail\.ch$/, /\.proton\.me$/], spf: [/^_spf\.protonmail\.ch$/, /(^|\.)proton\.me$/] },
  { id: 'fastmail', name: 'Fastmail', kind: 'mailbox', mx: [/\.messagingengine\.com$/], spf: [/^spf\.messagingengine\.com$/] },
  { id: 'hubspot', name: 'HubSpot', kind: 'sender', spf: [/(^|\.)hubspotemail\.net$/, /(^|\.)hubspot\.com$/] },
  { id: 'sparkpost', name: 'SparkPost', kind: 'sender', spf: [/^sparkpostmail\.com$/] },
  { id: 'cloudflare-email-routing', name: 'Cloudflare Email Routing', kind: 'mailbox', mx: [/\.mx\.cloudflare\.net$/], spf: [/^_spf\.mx\.cloudflare\.net$/] },
];

/** The provider id table: every id `detectProviders` can return, with its name and kind. */
export const PROVIDERS: readonly ProviderInfo[] = SIGNATURES.map(({ id, name, kind }) => ({ id, name, kind }));

export interface DetectedProvider extends ProviderInfo {
  /** Which signals matched, e.g. `mx:aspmx.l.google.com`, `spf-include:_spf.google.com` */
  evidence: string[];
}

export interface ProviderSignals {
  mxHosts?: string[];
  /** include:/redirect= targets of the SPF record (or any resolved nested include) */
  spfIncludes?: string[];
}

export function detectProviders(signals: ProviderSignals): DetectedProvider[] {
  const mx = (signals.mxHosts ?? []).map(h => h.toLowerCase().replace(/\.$/, ''));
  const inc = (signals.spfIncludes ?? []).map(h => h.toLowerCase().replace(/\.$/, ''));
  const found: DetectedProvider[] = [];
  for (const sig of SIGNATURES) {
    const evidence: string[] = [];
    for (const h of mx) if (sig.mx?.some(re => re.test(h))) evidence.push(`mx:${h}`);
    for (const h of inc) if (sig.spf?.some(re => re.test(h))) evidence.push(`spf-include:${h}`);
    if (evidence.length) found.push({ id: sig.id, name: sig.name, kind: sig.kind, evidence });
  }
  return found;
}
