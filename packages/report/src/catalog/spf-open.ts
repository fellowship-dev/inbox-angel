// Ported verbatim from unzip-inboxangel outreach-tools/catalog/spf-open.json.
import type { CatalogFile } from './types';

export const spfOpen: CatalogFile = {
  "finding": "spf-open",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "when": "has_other_terms",
      "exact": true,
      "title": "Close your SPF record",
      "why": "Your SPF record ends in {all_term}, which {all_meaning}. That weakens the check receivers run on your marketing and order emails.",
      "records": [
        {
          "name": "{domain}",
          "type": "TXT",
          "value": "{spf_value}",
          "note": "Same record with the ending changed to ~all. Move to -all once you are sure every sender is listed."
        }
      ],
      "steps": [
        "@dns_host"
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208"
      ]
    },
    {
      "provider": "*",
      "dns_host": "*",
      "when": "!has_other_terms",
      "exact": false,
      "title": "Replace your SPF record with one that lists your senders",
      "why": "Your SPF record is just `{spf_current}`, which {all_meaning} and lists no sending service. That weakens the check receivers run on your marketing and order emails.",
      "records": [],
      "steps": [
        "List your sending services first: your mailbox provider, your order-email sender, your newsletter tool. Check each provider's DNS settings page for its SPF include.",
        "Publish one record of the form `v=spf1 include:<first service> include:<second service> ~all` (changing `+all` alone to `~all` would authorise nobody).",
        "@dns_host"
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208"
      ]
    }
  ]
};
