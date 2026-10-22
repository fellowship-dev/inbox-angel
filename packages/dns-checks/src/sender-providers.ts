// Who is behind a sending IP? Matches what a DMARC aggregate report tells us about a source (reverse DNS,
// the IP's network owner, and the domains it authenticated as) against the same provider registry the SPF and
// DKIM checks use (`email-service-providers`), so "add the include / set up DKIM" advice names real records.

import { SPF_PROVIDERS, type EmailProvider } from './email-service-providers';

export interface SenderSignals {
	reverse_dns?: string | null;
	base_domain?: string | null;
	org?: string | null;
	spf_domain?: string | null;
	dkim_domain?: string | null;
}

export interface SenderProvider {
	id: string;
	name: string;
	/** The SPF-registry entry (include, DKIM selectors, setup guide), when this provider has one. */
	registry: EmailProvider | null;
	/** What matched, strongest first: the domain it authenticated as, then reverse DNS, then the network owner. */
	evidence: string;
	/** A static DKIM CNAME the customer can copy as is. Most providers issue account-specific values, so this is rare. */
	dkimCname?: { selector: string; target: string };
}

interface Signature {
	id: string;
	name: string;
	/** Registry `include` this provider maps to, if any. */
	include?: string;
	/** Domain suffixes seen in reverse DNS, base domain, or authenticated domains. */
	hosts: string[];
	/** Network owner names; weaker than hosts (a cloud ASN hosts many unrelated senders). */
	orgs?: RegExp[];
	dkimCname?: { selector: string; target: string };
}

const SIGNATURES: Signature[] = [
	{ id: 'google-workspace', name: 'Google Workspace', include: '_spf.google.com', hosts: ['google.com', 'googlemail.com', 'gmail.com'], orgs: [/^google\b/i] },
	{ id: 'microsoft-365', name: 'Microsoft 365', include: 'spf.protection.outlook.com', hosts: ['outlook.com', 'protection.outlook.com', 'microsoft.com', 'office365.com'], orgs: [/^microsoft\b/i] },
	{ id: 'sendgrid', name: 'SendGrid', include: 'sendgrid.net', hosts: ['sendgrid.net', 'sendgrid.com'], orgs: [/sendgrid/i] },
	{ id: 'amazon-ses', name: 'Amazon SES', include: 'amazonses.com', hosts: ['amazonses.com'] },
	{ id: 'mailgun', name: 'Mailgun', include: 'mailgun.org', hosts: ['mailgun.org', 'mailgun.net'], orgs: [/mailgun/i] },
	{ id: 'mailchimp', name: 'Mailchimp', include: 'servers.mcsv.net', hosts: ['mcsv.net', 'mailchimp.com', 'rsgsv.net', 'mcdlv.net'], orgs: [/mailchimp|rocket science/i], dkimCname: { selector: 'k1', target: 'dkim.mcsv.net' } },
	{ id: 'mandrill', name: 'Mandrill (Mailchimp)', include: 'mandrillapp.com', hosts: ['mandrillapp.com', 'mandrill.com'] },
	{ id: 'brevo', name: 'Brevo', include: 'spf.brevo.com', hosts: ['brevo.com', 'sendinblue.com', 'sendibt.com'], orgs: [/sendinblue|brevo/i] },
	{ id: 'mailjet', name: 'Mailjet', include: 'mailjet.com', hosts: ['mailjet.com'], orgs: [/mailjet/i] },
	{ id: 'postmark', name: 'Postmark', include: 'spf.postmarkapp.com', hosts: ['postmarkapp.com', 'mtasv.net'], orgs: [/postmark|wildbit/i] },
	{ id: 'resend', name: 'Resend', include: 'resend.com', hosts: ['resend.com', 'resend.dev'] },
	{ id: 'proton', name: 'Proton Mail', include: '_spf.protonmail.ch', hosts: ['protonmail.ch', 'proton.me'], orgs: [/proton/i] },
	{ id: 'hubspot', name: 'HubSpot', include: 'hubspot.net', hosts: ['hubspot.net', 'hubspot.com', 'hubspotemail.net'], orgs: [/hubspot/i] },
	{ id: 'zendesk', name: 'Zendesk', include: 'mail.zendesk.com', hosts: ['zendesk.com'], orgs: [/zendesk/i] },
	{ id: 'zoho', name: 'Zoho Mail', include: 'zoho.com', hosts: ['zoho.com', 'zoho.eu', 'zohomail.com'], orgs: [/zoho/i] },
	{ id: 'mxroute', name: 'MXRoute', include: 'mxroute.com', hosts: ['mxroute.com'] },
	{ id: 'fastmail', name: 'Fastmail', hosts: ['messagingengine.com', 'fastmail.com'], orgs: [/fastmail|messagingengine/i] },
	{ id: 'sparkpost', name: 'SparkPost', hosts: ['sparkpostmail.com', 'sparkpost.com'], orgs: [/sparkpost|messagebird/i] },
	{ id: 'shopify', name: 'Shopify Email', hosts: ['shopifyemail.com', 'shopify.com'], orgs: [/shopify/i] },
];

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\.$/, '');
const underHost = (name: string, host: string) => name === host || name.endsWith(`.${host}`);

/** The provider behind a report source, or null when we do not recognise it. */
export function identifySender(s: SenderSignals): SenderProvider | null {
	const probes: Array<[string, string]> = [
		['authenticated as', norm(s.spf_domain)],
		['authenticated as', norm(s.dkim_domain)],
		['reverse DNS', norm(s.reverse_dns)],
		['network', norm(s.base_domain)],
	];
	for (const [how, name] of probes) {
		if (!name) continue;
		const sig = SIGNATURES.find((g) => g.hosts.some((h) => underHost(name, h)));
		if (sig) return toProvider(sig, `${how} ${name}`);
	}
	const org = (s.org ?? '').trim();
	if (org) {
		const sig = SIGNATURES.find((g) => g.orgs?.some((re) => re.test(org)));
		if (sig) return toProvider(sig, `network owner ${org}`);
	}
	return null;
}

function toProvider(sig: Signature, evidence: string): SenderProvider {
	const registry = sig.include ? (SPF_PROVIDERS.find((p) => p.include === sig.include) ?? null) : null;
	return { id: sig.id, name: sig.name, registry, evidence, ...(sig.dkimCname ? { dkimCname: sig.dkimCname } : {}) };
}
