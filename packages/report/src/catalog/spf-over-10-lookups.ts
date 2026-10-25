// Ported verbatim from unzip-inboxangel outreach-tools/catalog/spf-over-10-lookups.json.
import type { CatalogFile } from './types';

export const spfOver10Lookups: CatalogFile = {
  "finding": "spf-over-10-lookups",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Bring SPF back under 10 DNS lookups",
      "why": "The SPF record on {domain} needs more than 10 DNS lookups ({lookups}). Past 10, SPF returns a permanent error (RFC 7208), so SPF fails for your marketing and order emails.",
      "records": [],
      "steps": [
        "Your current record is: `{spf_current}`. It reaches: {includes}.",
        "List the services you still send from. Remove the include for any you no longer use; each include counts as a lookup, and so does each of their own includes.",
        "Some providers do not need an include at your root domain at all: for example Postmark says its include is no longer required, and Resend and Amazon SES (with a custom MAIL FROM) check SPF on their own subdomain.",
        "Edit the TXT record for {domain}, save, and re-check the lookup count."
      ],
      "provider_hints": {
        "postmark": "Postmark: \"It is no longer required to include Postmark in your own custom SPF record\" (Postmark docs), so include:spf.mtasv.net can go.",
        "resend": "Resend publishes SPF on a send subdomain, not at the root domain (Resend docs), so a Resend include at the root is not what its records ask for.",
        "amazon-ses": "Amazon SES with a custom MAIL FROM domain is checked on that subdomain's SPF record, not the root (SES docs)."
      },
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208",
        "https://postmarkapp.com/support/article/how-do-i-set-up-spf-for-postmark",
        "https://resend.com/docs/knowledge-base/cloudflare",
        "https://docs.aws.amazon.com/ses/latest/dg/mail-from.html"
      ]
    }
  ]
};
