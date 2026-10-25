// Ported verbatim from unzip-inboxangel outreach-tools/catalog/spf-missing.json.
import type { CatalogFile } from './types';

export const spfMissing: CatalogFile = {
  "finding": "spf-missing",
  "entries": [
    {
      "provider": "google-workspace",
      "dns_host": "*",
      "exact": true,
      "title": "Publish an SPF record for Google Workspace",
      "why": "{domain} has no SPF record. SPF is how Gmail and Outlook check that a server is allowed to send as {domain}; without it your marketing and order emails can fail the check and be filtered as spam. Gmail requires SPF or DKIM from every sender.",
      "records": [
        {
          "name": "{domain}",
          "type": "TXT",
          "value": "v=spf1 include:_spf.google.com ~all",
          "note": "Host `@` (the root domain). If you also send through another service, add its include before ~all, and keep it to one SPF record."
        }
      ],
      "steps": [
        "@dns_host",
        "SPF can take up to 48 hours to take effect (Google's guidance), usually far less.",
        "Check there is only one SPF TXT record on {domain}."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://knowledge.workspace.google.com/admin/security/set-up-spf",
        "https://support.google.com/a/answer/81126",
        "https://www.rfc-editor.org/rfc/rfc7208"
      ]
    },
    {
      "provider": "microsoft-365",
      "dns_host": "*",
      "exact": true,
      "title": "Publish an SPF record for Microsoft 365",
      "why": "{domain} has no SPF record. SPF is how Gmail and Outlook check that a server is allowed to send as {domain}; without it your marketing and order emails can fail the check and be filtered as spam.",
      "records": [
        {
          "name": "{domain}",
          "type": "TXT",
          "value": "v=spf1 include:spf.protection.outlook.com ~all",
          "note": "Microsoft's own example ends in -all; ~all is the gentler start while you confirm every service that sends as {domain}. Keep to one SPF record."
        }
      ],
      "steps": [
        "Microsoft 365 has no admin-portal page for SPF: you create this at your DNS host.",
        "@dns_host",
        "Check there is only one SPF TXT record on {domain}."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-spf-configure",
        "https://www.rfc-editor.org/rfc/rfc7208"
      ]
    },
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Publish an SPF record",
      "why": "{domain} has no SPF record. SPF is how Gmail and Outlook check that a server is allowed to send as {domain}; without it your marketing and order emails can fail the check and be filtered as spam. Gmail requires SPF or DKIM from every sender.",
      "records": [
        {
          "name": "{domain}",
          "type": "TXT",
          "value": "v=spf1 include:<your mail provider's SPF host> ~all",
          "note": "Your mail provider's DNS settings page names the include to use."
        }
      ],
      "needs_from_provider": [
        "the SPF include host of each service that sends as the domain"
      ],
      "steps": [
        "List every service that sends mail as {domain}: your mailbox provider, your order-email sender, your newsletter tool.",
        "Check each provider's DNS settings page for its SPF include (some, like Postmark and Resend, publish SPF on their own subdomain instead and need nothing here).",
        "@dns_host",
        "Keep to one SPF record and under 10 DNS lookups."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208",
        "https://postmarkapp.com/support/article/how-do-i-set-up-spf-for-postmark",
        "https://resend.com/docs/knowledge-base/cloudflare"
      ]
    }
  ]
};
