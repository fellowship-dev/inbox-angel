// Ported verbatim from unzip-inboxangel outreach-tools/catalog/multiple-spf.json.
import type { CatalogFile } from './types';

export const multipleSpf: CatalogFile = {
  "finding": "multiple-spf",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": true,
      "title": "Merge your SPF records into one",
      "why": "{domain} publishes more than one SPF record. Receivers treat that as a permanent error (RFC 7208), so SPF fails for every email you send, including marketing and order emails.",
      "records": [
        {
          "name": "{domain}",
          "type": "TXT",
          "value": "{spf_value}",
          "note": "Built from the mechanisms in your current records. Delete the old SPF records; keep only this one. Check that it stays within 10 DNS lookups."
        }
      ],
      "steps": [
        "Open the DNS records for {domain} and find every TXT record starting `v=spf1`.",
        "Replace them all with the single merged record below.",
        "@dns_host",
        "Delete the other SPF records."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208",
        "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-spf-configure"
      ]
    }
  ]
};
