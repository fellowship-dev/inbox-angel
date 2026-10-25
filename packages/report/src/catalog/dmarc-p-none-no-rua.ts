// Ported from unzip-inboxangel outreach-tools/catalog/dmarc-p-none-no-rua.json.
// Deviation from the Z JSON (plan KTD6): the derived value carries rua=mailto:dmarc@{domain}; the note follows.
import type { CatalogFile } from './types';

export const dmarcPNoneNoRua: CatalogFile = {
  "finding": "dmarc-p-none-no-rua",
  "entries": [
    {
      "provider": "*",
      "dns_host": "*",
      "exact": false,
      "title": "Turn on DMARC reports",
      "why": "Your DMARC record is on p=none and has no rua= address, so receivers have nowhere to send reports. You are publishing a policy and cannot see whether your marketing and order emails pass.",
      "records": [
        {
          "name": "_dmarc.{domain}",
          "type": "TXT",
          "value": "{dmarc_value}",
          "note": "rua= sends the daily DMARC summaries to dmarc@{domain}: create that mailbox or alias first, or change the address to one you read."
        }
      ],
      "steps": [
        "Pick a mailbox you actually read for the reports.",
        "@dns_host",
        "Reports arrive daily as XML attachments from Gmail, Outlook and others."
      ],
      "caveat": "This is an authentication fix. Whether Gmail or Outlook then puts a given email in the inbox also depends on your sending reputation, which no DNS record controls.",
      "sources": [
        "https://www.rfc-editor.org/rfc/rfc7489",
        "https://resend.com/docs/dashboard/domains/dmarc"
      ]
    }
  ]
};
