// Ported verbatim from unzip-inboxangel outreach-tools/catalog/dmarc-invalid.json.
import type { CatalogFile } from './types';

export const dmarcInvalid: CatalogFile = {
  "finding": "dmarc-invalid",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Fix the DMARC record's syntax",
      "why": "The DMARC record on {domain} has syntax problems, and receivers ignore a record they cannot parse. That leaves you with no working DMARC policy.",
      "records": [],
      "steps": [
        "Open the `_dmarc` TXT record for {domain}.",
        "Fix the problems listed in the evidence (tags are `name=value` pairs separated by `;`, starting with `v=DMARC1`).",
        "Save and re-check."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7489"
      ]
    }
  ]
};
