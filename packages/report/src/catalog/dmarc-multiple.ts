// Ported verbatim from unzip-inboxangel outreach-tools/catalog/dmarc-multiple.json.
import type { CatalogFile } from './types';

export const dmarcMultiple: CatalogFile = {
  "finding": "dmarc-multiple",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Leave one DMARC record",
      "why": "{domain} publishes more than one DMARC record at _dmarc. With several, DMARC does not apply (RFC 7489 section 6.6.3), so it is as if you had none.",
      "records": [
        {
          "name": "_dmarc.{domain}",
          "type": "TXT",
          "value": "{dmarc_value}",
          "note": "This is the first of your records. Keep whichever one you meant to keep and delete the rest."
        }
      ],
      "steps": [
        "Open the DNS records for {domain} and list the TXT records named `_dmarc`.",
        "Delete all but one. Edit the survivor if needed.",
        "Re-check: `_dmarc.{domain}` should return exactly one record."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7489"
      ]
    }
  ]
};
