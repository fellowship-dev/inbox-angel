// Ported verbatim from unzip-inboxangel outreach-tools/catalog/spf-permerror.json.
import type { CatalogFile } from './types';

export const spfPermerror: CatalogFile = {
  "finding": "spf-permerror",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Repair your broken SPF record",
      "why": "The SPF record on {domain} cannot be evaluated (the problem is named in the evidence). Receivers treat that as a permanent error, so SPF fails for your marketing and order emails.",
      "records": [],
      "steps": [
        "Your current record is: `{spf_current}`.",
        "Fix the problem named in the evidence: a typo, an include pointing at a name with no SPF record, a loop, or too many lookups.",
        "Save the corrected single record and re-check."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7208"
      ]
    }
  ]
};
