// Ported verbatim from unzip-inboxangel outreach-tools/catalog/spf-no-all.json.
import type { CatalogFile } from './types';

export const spfNoAll: CatalogFile = {
  "finding": "spf-no-all",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": true,
      "title": "Finish your SPF record with ~all",
      "why": "Your SPF record has no ending rule, so it does not say what to do with servers it does not list.",
      "records": [
        {
          "name": "{domain}",
          "type": "TXT",
          "value": "{spf_value}",
          "note": "Your record with ~all added."
        }
      ],
      "steps": [
        "@dns_host"
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208"
      ]
    }
  ]
};
