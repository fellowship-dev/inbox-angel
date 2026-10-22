/** Known email provider registry: SPF includes + DKIM selectors. Port of dashboard/src/email-service-providers.ts. */
export interface EmailProvider {
	/** SPF include domain (empty string for DKIM-only providers). */
	include: string;
	name: string;
	/** DKIM selector prefixes (the part before ._domainkey). */
	dkimSelectors?: string[];
	dkimGuideUrl?: string;
}

export const SPF_PROVIDERS: EmailProvider[] = [
	{ include: '_spf.google.com', name: 'Google Workspace', dkimSelectors: ['google'], dkimGuideUrl: 'https://support.google.com/a/answer/174124' },
	{ include: 'spf.protection.outlook.com', name: 'Microsoft 365', dkimSelectors: ['selector1', 'selector2'], dkimGuideUrl: 'https://learn.microsoft.com/en-us/microsoft-365/security/office-365-security/email-authentication-dkim-configure' },
	{ include: 'sendgrid.net', name: 'SendGrid', dkimSelectors: ['smtpapi', 's1', 's2'], dkimGuideUrl: 'https://docs.sendgrid.com/ui/account-and-settings/dkim-records' },
	{ include: 'amazonses.com', name: 'Amazon SES', dkimSelectors: [], dkimGuideUrl: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html' },
	{ include: 'mailgun.org', name: 'Mailgun', dkimSelectors: ['smtp', 'mailo', 'k1'], dkimGuideUrl: 'https://documentation.mailgun.com/docs/mailgun/user-manual/get-started/#verify-your-domain' },
	{ include: 'mandrillapp.com', name: 'Mandrill (Mailchimp)', dkimSelectors: ['mandrill'], dkimGuideUrl: 'https://mailchimp.com/developer/transactional/docs/authentication-delivery/#authentication' },
	{ include: 'servers.mcsv.net', name: 'Mailchimp', dkimSelectors: ['k1'], dkimGuideUrl: 'https://mailchimp.com/help/set-up-email-domain-authentication/' },
	{ include: 'spf.brevo.com', name: 'Brevo', dkimSelectors: ['mail'], dkimGuideUrl: 'https://help.brevo.com/hc/en-us/articles/12163873383186' },
	{ include: 'mailjet.com', name: 'Mailjet', dkimSelectors: ['mailjet'], dkimGuideUrl: 'https://documentation.mailjet.com/hc/en-us/articles/360042412734' },
	{ include: 'spf.postmarkapp.com', name: 'Postmark', dkimSelectors: ['pm'], dkimGuideUrl: 'https://postmarkapp.com/support/article/1002-getting-started-with-postmark#dkim' },
	{ include: 'resend.com', name: 'Resend', dkimSelectors: ['resend'], dkimGuideUrl: 'https://resend.com/docs/dashboard/domains/introduction' },
	{ include: '_spf.protonmail.ch', name: 'Proton Mail', dkimSelectors: ['protonmail', 'protonmail2', 'protonmail3'], dkimGuideUrl: 'https://proton.me/support/anti-spoofing-custom-domain' },
	{ include: 'hubspot.net', name: 'HubSpot', dkimSelectors: ['hs1', 'hs2'], dkimGuideUrl: 'https://knowledge.hubspot.com/marketing-email/connect-your-email-sending-domain' },
	{ include: 'mail.zendesk.com', name: 'Zendesk', dkimSelectors: ['zendesk1', 'zendesk2'], dkimGuideUrl: 'https://support.zendesk.com/hc/en-us/articles/4408882165530' },
	{ include: 'zoho.com', name: 'Zoho Mail', dkimSelectors: ['zoho'], dkimGuideUrl: 'https://www.zoho.com/mail/help/adminconsole/dkim-configuration.html' },
	{ include: 'mxroute.com', name: 'MXRoute', dkimSelectors: ['x'], dkimGuideUrl: 'https://mxroutedocs.com/dns/dkim/' },
];

/** DKIM-only providers: no SPF include, but known DKIM selectors. */
export const DKIM_ONLY_PROVIDERS: EmailProvider[] = [
	{ include: '', name: 'Fastmail', dkimSelectors: ['fm1', 'fm2', 'fm3'], dkimGuideUrl: 'https://www.fastmail.help/hc/en-us/articles/360060591153' },
];

const ALL_DKIM_PROVIDERS: EmailProvider[] = [
	...SPF_PROVIDERS.filter((p) => p.dkimSelectors && p.dkimSelectors.length > 0),
	...DKIM_ONLY_PROVIDERS,
];

/** "google._domainkey.example.com", "google._domainkey" or "google" -> "google". */
export function extractSelector(selectorName: string): string {
	const idx = selectorName.indexOf('._domainkey');
	return (idx >= 0 ? selectorName.slice(0, idx) : selectorName).toLowerCase();
}

/** Match a DKIM selector name (FQDN, partial or bare prefix) to a known provider. */
export function matchDkimProvider(selectorName: string): EmailProvider | null {
	const selector = extractSelector(selectorName);
	return ALL_DKIM_PROVIDERS.find((p) => p.dkimSelectors?.some((s) => s.toLowerCase() === selector)) ?? null;
}

/** Known providers named by an `include:` in the record (exact, case-insensitive match on the include domain). */
export function detectProviders(spfRecord: string): EmailProvider[] {
	const includes = new Set(
		(spfRecord.match(/include:([^\s]+)/gi) ?? []).map((m) => m.slice('include:'.length).toLowerCase()),
	);
	return SPF_PROVIDERS.filter((p) => includes.has(p.include.toLowerCase()));
}

/**
 * Providers present in SPF whose DKIM selectors were not detected. A provider with no known
 * selectors can never be verified, so it is always listed.
 */
export function findUnsignedSpfProviders(detectedSelectors: { name: string }[], spfRecord: string | null): EmailProvider[] {
	if (!spfRecord) return [];
	const detected = new Set(detectedSelectors.map((s) => extractSelector(s.name)));
	return detectProviders(spfRecord).filter((p) => {
		if (!p.dkimSelectors || p.dkimSelectors.length === 0) return true;
		return !p.dkimSelectors.some((sel) => detected.has(sel.toLowerCase()));
	});
}

/** Deduplicated DKIM selector prefixes worth probing, plus the generic ones not tied to an ESP. */
export function getAllDkimSelectors(): string[] {
	const all = new Set<string>();
	for (const p of [...SPF_PROVIDERS, ...DKIM_ONLY_PROVIDERS]) for (const sel of p.dkimSelectors ?? []) all.add(sel);
	for (const generic of ['default', 'dkim', 'mail']) all.add(generic);
	return [...all];
}
